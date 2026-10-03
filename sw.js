// SqueveTrack service worker
// Jobs, in priority order:
//   1. Show notifications through registration.showNotification() (needed on mobile) and route taps back
//      into the app at the right screen (PTP hub, a specific borrower).
//   2. Receive server push so PTP reminders arrive while the app is CLOSED.
//   3. Open instantly and work offline. The app shell is saved at install time under a name that includes
//      the deploy's build number, so a new deploy installs a complete new copy before it takes over, and the
//      app's own "new version is ready" banner tells the user. Nothing can be half old, half new.

// Stamped on each deployment by stamp-version.sh. It also makes this file change byte-for-byte on every
// deploy, which is what makes browsers install the new worker.
const SW_BUILD = '__SQ_BUILD__';
const CACHE_NAME = 'squevetrack-' + SW_BUILD;   // the app shell: replaced on every deploy
const LIBS_CACHE = 'squevetrack-libs-v1';       // CDN libraries: kept across deploys, refreshed in the background
const PRECACHE = ['./', './manifest.json', './icon-192.png', './icon-512.png'];

// Cross-origin hosts whose responses are safe to keep for offline use (static libraries and fonts only).
// Everything else cross-origin (Supabase, the Anthropic/OpenAI/Gemini APIs) is left alone: never cached.
const CACHEABLE_CROSS_ORIGIN = [
  'cdn.jsdelivr.net', 'cdn.sheetjs.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'
];

self.addEventListener('install', (event) => {
  // Download the whole shell first (bypassing the HTTP cache). If anything fails the install fails and the
  // current version keeps running; the browser retries on the next update check.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.indexOf('squevetrack-') === 0 && k !== CACHE_NAME && k !== LIBS_CACHE)
          .map((k) => caches.delete(k))
      ))
      .catch(() => {})
      .then(() => clients.claim())
  );
});

// Same-origin files: served from the saved copy first (instant, works offline).
async function shell(req) {
  const cache = await caches.open(CACHE_NAME);
  // Every page load, whatever its URL or ?query (e.g. ./?notif=ptp), gets the saved app page
  const hit = await cache.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok && req.mode !== 'navigate') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    return (await caches.match(req)) || Response.error();
  }
}

// CDN libraries: use the saved copy right away and refresh it in the background.
function libs(event, req) {
  return caches.open(LIBS_CACHE).then(async (cache) => {
    const hit = await cache.match(req);
    const net = fetch(req, { cache: 'no-store' })
      .then((res) => {
        // opaque = cross-origin <script> without CORS; can't be inspected but is fine to keep
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => null);
    if (hit) { event.waitUntil(net); return hit; }
    return (await net) || Response.error();
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && CACHEABLE_CROSS_ORIGIN.indexOf(url.hostname) === -1) return;
  // never serve these from the saved copy: the browser checks sw.js itself, and the push key must be current
  if (sameOrigin && /\/(sw\.js|push-config\.json)$/.test(url.pathname)) return;
  event.respondWith(sameOrigin ? shell(req) : libs(event, req));
});

// Server push: PTP reminders while the app is closed.
// If the app is open and on screen its own timers already show the alert, so we stay quiet (browsers allow that
// exactly when a visible window exists). Same notification tag as the local alert, so it never shows twice.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (e) { d = { title: 'Reminder', body: event.data ? event.data.text() : '' }; }

  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible')) return;
    const tag = d.tag || 'sq-push';
    const opts = {
      body: d.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: tag,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { url: d.url || '' }
    };
    // Promise alerts get one-tap buttons (Android/desktop; iPhone ignores them and just opens the app)
    if (/^ptp-(ind|miss)-/.test(tag)) {
      const max = (self.Notification && self.Notification.maxActions) || 2;
      const all = [{ action: 'paid', title: '\u2705 Paid' }, { action: 'snooze', title: '\u23F0 Snooze 15m' }, { action: 'resched', title: '\u{1F501} Reschedule' }];
      opts.actions = (max >= 3 ? all : all.slice(0, 2)).slice(0, max);
    }
    await self.registration.showNotification(d.title || 'Reminder', opts);
  })());
});

// The browser replaced this device's push address: ask an open page to register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => list.forEach((c) => c.postMessage({ type: 'sq-push-resubscribe' })))
  );
});

// Tapping a notification: focus an already-open tab if one exists (and hand it the deep link via postMessage so
// it can navigate without a reload), otherwise open a new one with ?notif=... which index.html reads on load.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = (event.notification.data && event.notification.data.url) || '';
  // a button was tapped: pass it on so the app opens the payment box / reschedule box for that borrower
  if ((event.action === 'paid' || event.action === 'resched') && /^\?notif=borrower:/.test(url)) url += '&act=' + event.action;
  // Snooze: ask the server to send this same alert again in 15 minutes (works with the app closed)
  if (event.action === 'snooze') { event.waitUntil(snoozeAlert(event.notification)); return; }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (url) client.postMessage({ type: 'sq-notif-click', url });
          return;
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url ? ('./' + url) : './');
      }
    })
  );
});


// Re-queue a notification on the server (push_snooze) so it comes back after `mins` minutes. The Supabase address and the
// public anon key come from push-config.json, which the site already serves. If anything fails the user is told, never left guessing.
async function snoozeAlert(n, mins = 15) {
  try {
    const cfg = await (await fetch('./push-config.json', { cache: 'no-store' })).json();
    const sub = await self.registration.pushManager.getSubscription();
    if (!cfg.supabaseUrl || !cfg.supabaseKey || !sub) throw new Error('not set up');
    const r = await fetch(cfg.supabaseUrl + '/rest/v1/rpc/push_snooze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: cfg.supabaseKey, authorization: 'Bearer ' + cfg.supabaseKey },
      body: JSON.stringify({ p_endpoint: sub.endpoint, p_title: n.title, p_body: n.body || '', p_tag: n.tag || 'sq-snooze', p_url: (n.data && n.data.url) || '', p_mins: mins })
    });
    if (!r.ok) throw new Error('server ' + r.status);
  } catch (e) {
    await self.registration.showNotification('Snooze did not work', { body: 'Open the app to handle this reminder.', icon: './icon-192.png', tag: 'sq-snooze-fail', data: { url: (n.data && n.data.url) || '' } });
  }
}

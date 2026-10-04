#!/usr/bin/env node
/* SqueveTrack smoke test — boots the BUILT site in headless Chrome and fails the deploy if basics are broken.
 *   node tests/smoke.js <site-folder> [--stamped]
 * Runs offline on purpose: every request that is not to the local test server is blocked, so the result
 * doesn't depend on CDNs or Supabase being reachable. Set CHROME_PATH to use an existing Chrome binary. */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');

const root = path.resolve(process.argv[2] || 'dist');
const needStamp = process.argv.includes('--stamped');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
  fs.readFile(f.startsWith(root) ? f : '', (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

const now = new Date();
const today = now.toISOString().slice(0, 10);
const due = new Date(now.getTime() + 40 * 60000).toISOString().slice(0, 16).replace('T', ' ');
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// A signed-in agent with one promise due in 40 minutes (same storage shape the app writes itself)
const SEED = `(() => {
  const id = 'testagent';
  localStorage.setItem('sq_agents', JSON.stringify([{ id, name: 'Test Agent', lbCode: 'LB001', pinHash: 'x' }]));
  sessionStorage.setItem('sq_unlocked', JSON.stringify({ id, name: 'Test Agent', ts: Date.now() }));
  sessionStorage.setItem('sq_dcoy_ok', '1');
  localStorage.setItem('pwa_installed', '1');
  const st = { borrowers: [{ id: 'b1', name: 'Kofi Mensah', phone: '0240000000', loanAmount: 1000, loanDue: 1200, amountPaid: 0,
      startDate: '${today}', status: 'unpaid', isPaid: false, promisedToPay: true, promiseDate: '${due}', ptpConfidence: 'hot' }],
    dailyLog: [], month: '${MONTHS[now.getMonth()]} ${now.getFullYear()}', discountRate: 0.3, monthlyTarget: 50000, agedOutLog: [], archive: [],
    hitList: [], callLog: {}, rankingHistory: [], undoHistory: [], pendingSyncCount: 0, offlineQueue: [], customMessages: [],
    archivedBorrowers: [], ptpHistory: [], templatePerf: {}, scoreHistory: [], messageBank: [],
    agentProfile: { setupComplete: true, lbCode: 'LB001', name: 'Test Agent', stage: 'M2' }, m2TargetLocks: {}, m2DayReviews: {}, msgFavorites: [] };
  localStorage.setItem('squevetrack_' + id, JSON.stringify(st));
  window.__badge = [];
  Object.defineProperty(navigator, 'setAppBadge', { value: n => { window.__badge.push(n); return Promise.resolve(); }, configurable: true });
  Object.defineProperty(navigator, 'clearAppBadge', { value: () => { window.__badge.push(0); return Promise.resolve(); }, configurable: true });
})();`;

// Minimal stand-in for the cloud table, used to test the two-device overwrite guard
const FAKE_DB = `window.__mkFake = function () {
  const f = { upserts: 0, n: 0, row: { id: 'agent_testagent', data: { borrowers: [], _lastSaveTs: 1 }, updated_at: '2026-10-01T10:00:00.000+00:00' } };
  f.from = () => ({
    select: cols => ({ eq: () => { const r = () => { const o = {}; if (cols.includes('data')) o.data = f.row.data; if (cols.includes('updated_at')) o.updated_at = f.row.updated_at; return Promise.resolve({ data: o, error: null }); }; return { maybeSingle: r, single: r }; } }),
    upsert: obj => ({ select: () => { f.upserts++; f.n++; f.row = { id: obj.id, data: obj.data, updated_at: '2026-10-01T11:00:' + String(f.n).padStart(2, '0') + '.000+00:00' }; return Promise.resolve({ data: [{ updated_at: f.row.updated_at }], error: null }); } })
  });
  return f; };`;

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   -> ' + detail)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(browser, base, vw, vh, label) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, isMobile: vw < 600, hasTouch: vw < 600, permissions: ['notifications'] });
  await ctx.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const errors = [], csp = [];
  page.on('pageerror', e => { if (!/Failed to load Chart\.js/.test(e.message)) errors.push(e.message.slice(0, 160)); });
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 160)); });
  // Some headless Chrome builds (the one GitHub Actions uses) ignore the permission grant and report "denied".
  // We are testing the APP's reminder logic, not the browser's permission UI, so pin the permission state.
  await page.addInitScript(() => { try { Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true }); } catch (e) {} });
  await page.addInitScript(SEED);
  await page.addInitScript(FAKE_DB);
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await sleep(5500);

  check(`[${label}] app boots without uncaught errors`, errors.length === 0, errors.join(' | '));
  check(`[${label}] no Content-Security-Policy violations`, csp.length === 0, csp.join(' | '));

  const ver = await page.evaluate(() => window.SQ_VERSION && window.SQ_VERSION.build);
  check(`[${label}] version is stamped`, !needStamp || /^\d+$/.test(String(ver)), 'build = ' + ver);

  const pages = await page.evaluate(() => [...new Set([...document.querySelectorAll('.nav-item[data-page]')].map(e => e.dataset.page))]);
  check(`[${label}] navigation lists pages`, pages.length >= 8, 'found ' + pages.length);
  for (const pg of pages) {
    const before = errors.length;
    await page.evaluate(p => navigate(p), pg);
    await sleep(450);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`[${label}] page "${pg}" renders cleanly and fits the screen`, errors.length === before && over <= 2, (errors.slice(before).join(' | ')) + (over > 2 ? ` overflow ${over}px` : ''));
  }

  const loaded = await page.evaluate(() => !!(typeof _sessionUnlocked !== 'undefined' && _sessionUnlocked && state && state.borrowers && state.borrowers.length === 1));
  check(`[${label}] signed-in session restores on reload (no PIN prompt, data loaded)`, loaded, 'session or data not restored');

  const alarms = await page.evaluate(() => Object.keys(_ptpReminderTimeouts).length);
  const why = alarms === 1 ? '' : await page.evaluate(() => JSON.stringify({ permission: Notification.permission, remindersFlag: localStorage.getItem('ptp_reminders_enabled'), borrowers: state && state.borrowers && state.borrowers.length, promiseDate: state && state.borrowers && state.borrowers[0] && state.borrowers[0].promiseDate, browserNow: new Date().toString() }));
  check(`[${label}] PTP alarm is scheduled for the promise due in 40 min`, alarms === 1, 'alarms = ' + alarms + ' ' + why);
  const badge = await page.evaluate(() => window.__badge);
  // The seeded promise is 40 minutes from now. If the run happens in the last 40 minutes before midnight (UTC), that promise
  // lands on TOMORROW, so "due today" is correctly 0 and the badge is cleared. Expect whichever is right for the clock.
  const wantBadge = due.startsWith(today) ? 1 : 0;
  check(`[${label}] icon badge shows ${wantBadge} promise${wantBadge === 1 ? '' : 's'} due today`, badge.length > 0 && badge[badge.length - 1] === wantBadge, JSON.stringify(badge));

  await page.evaluate(() => navigate('ranking')); await sleep(400);
  await page.evaluate(() => openRankingLogPanel()); await sleep(600);
  const sheet = await page.evaluate(() => {
    const top = sel => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === t || el.contains(t); };
    return { scan: top('#ranking-scan-btn'), close: top('.rlog-close'), pill: getComputedStyle(document.getElementById('daily-target-pill')).display };
  });
  check(`[${label}] ranking sheet buttons are clickable (nothing floats over them)`, sheet.scan && sheet.close && sheet.pill === 'none', JSON.stringify(sheet));
  await page.evaluate(() => closeRankingLogPanel()); await sleep(300);

  if (label === 'desktop') {
    let sw = 0;
    for (let i = 0; i < 20 && !sw; i++) { sw = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length)); if (!sw) await sleep(500); }
    check(`[${label}] service worker registers`, sw === 1, 'registrations = ' + sw);

    if (!loaded) { check(`[${label}] overwrite guard checks`, false, 'skipped: app data was not loaded'); await ctx.close(); return; }
    await page.evaluate(() => { window.__f = __mkFake(); _db = __f; _remoteStamp = __f.row.updated_at; state.borrowers[0].name = 'edit one'; saveState(); });
    await sleep(1800);
    const a = await page.evaluate(() => ({ up: __f.upserts, modal: document.getElementById('modal-title').textContent === 'Sync conflict' }));
    check(`[${label}] normal save reaches the cloud`, a.up === 1 && !a.modal, JSON.stringify(a));
    await page.evaluate(() => { __f.row = { id: 'agent_testagent', data: { borrowers: [], _lastSaveTs: 2 }, updated_at: '2026-10-01T12:00:00.000+00:00' }; state.borrowers[0].name = 'edit two'; saveState(); });
    await sleep(1800);
    const b = await page.evaluate(() => ({ up: __f.upserts, modal: document.getElementById('modal-title').textContent === 'Sync conflict' && document.getElementById('modal-overlay').classList.contains('open') }));
    check(`[${label}] save is held (not overwritten) when another device saved first`, b.up === 1 && b.modal, JSON.stringify(b));

    // the app shell is saved at install time, so the app must open even with no connection
    let saved = false;
    for (let i = 0; i < 20 && !saved; i++) { saved = await page.evaluate(() => caches.keys().then(k => k.some(n => /^squevetrack-(?!libs)/.test(n)))); if (!saved) await sleep(500); }
    check(`[${label}] app shell is saved for offline use`, saved, 'no app-shell cache found');
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    let off = {};
    // Poll instead of a fixed pause: a slow runner must not fail this, but a start that takes 10+ s is a real problem.
    for (let i = 0; i < 40; i++) {
      off = await page.evaluate(() => ({ booted: !!window.SQ_VERSION, unlocked: typeof _sessionUnlocked !== 'undefined' && _sessionUnlocked, rows: (state && state.borrowers) ? state.borrowers.length : null }));
      if (off.rows === 1) break;
      await sleep(500);
    }
    off.seconds = Math.round((Date.now() - t0) / 100) / 10;
    check(`[${label}] app starts with no connection and shows saved data within 11 s`, off.booted && off.unlocked && off.rows === 1 && off.seconds <= 11, JSON.stringify(off));
    await ctx.setOffline(false);
  }
  await ctx.close();
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    await run(browser, base, 1280, 800, 'desktop');
    await run(browser, base, 390, 844, 'mobile');
  } finally { await browser.close(); server.close(); }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('smoke test crashed:', e); process.exit(2); });

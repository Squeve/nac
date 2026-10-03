// SqueveTrack — send-reminders (Supabase Edge Function)
// Called every minute by pg_cron. Reads each agent's uploaded reminder schedule, sends every alert that is due
// right now to that agent's devices with Web Push, and records what it sent so nothing goes out twice.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// ── BEGIN-PURE (unit-tested, no imports needed) ──────────────────────────────
export const GRACE_MS = 20 * 60 * 1000; // an alert still goes out up to 20 min late (cron hiccup), never after that
export interface Item { k: string; at: number; title: string; body: string; tag: string; url: string }

export function cleanItem(raw: any): Item | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.k !== "string" || typeof raw.title !== "string") return null;
  if (typeof raw.at !== "number" || !isFinite(raw.at)) return null;
  const tag = typeof raw.tag === "string" && /^[\w:-]{1,60}$/.test(raw.tag) ? raw.tag : "sq-reminder";
  const url = typeof raw.url === "string" && raw.url.startsWith("?notif=") && raw.url.length <= 80 ? raw.url : "?notif=ptp";
  return { k: raw.k.slice(0, 120), at: raw.at, title: raw.title.slice(0, 120), body: String(raw.body ?? "").slice(0, 300), tag, url };
}

export function pickDue(items: unknown, nowMs: number, graceMs = GRACE_MS): Item[] {
  if (!Array.isArray(items)) return [];
  return items.map(cleanItem).filter((x): x is Item => !!x && x.at <= nowMs && nowMs - x.at <= graceMs);
}

export const sentKey = (agent: string, it: Item) => `${agent}|${it.k}|${it.at}`;
// ── END-PURE ─────────────────────────────────────────────────────────────────

export interface Deps {
  sb: any;                       // supabase client (service role)
  push: any;                     // web-push
  now: () => number;
  env: (k: string) => string | undefined;
  prepare: () => void;           // sets the VAPID details (only after the caller is authenticated)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  const secret = d.env("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("forbidden", { status: 403 });
  d.prepare();

  const { sb, push } = d;
  const now = d.now();
  await sb.from("push_sent").delete().lt("sent_at", new Date(now - 3 * 86400000).toISOString());

  const { data: rows, error } = await sb.from("push_schedule").select("agent_id, items");
  if (error) return json({ ok: false, error: error.message }, 500);

  const stats = { agents: 0, due: 0, sent: 0, skipped: 0, removed: 0, failed: 0 };
  for (const row of rows ?? []) {
    const due = pickDue(row.items, now);
    if (!due.length) continue;
    stats.agents++;
    const { data: subs } = await sb.from("push_subscriptions").select("endpoint, p256dh, auth").eq("agent_id", row.agent_id);
    if (!subs || !subs.length) continue;

    for (const it of due) {
      stats.due++;
      const key = sentKey(row.agent_id, it);
      const { error: claim } = await sb.from("push_sent").insert({ key }); // unique key: a second run can't send it again
      if (claim) { stats.skipped++; continue; }

      const payload = JSON.stringify({ title: it.title, body: it.body, tag: it.tag, url: it.url });
      let ok = 0, bad = 0;
      await Promise.all(subs.map(async (s: any) => {
        try {
          // TTL 15 min: a "promise in 15 minutes" alert is useless if the phone was off and gets it an hour later
          await push.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 900, urgency: "high" });
          ok++;
        } catch (e: any) {
          const code = e?.statusCode;
          if (code === 404 || code === 410) { await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint); stats.removed++; }
          else bad++;
        }
      }));
      stats.sent += ok; stats.failed += bad;
      if (ok === 0 && bad > 0) await sb.from("push_sent").delete().eq("key", key); // nobody got it: allow a retry inside the grace window
    }
  }
  return json({ ok: true, ...stats });
}

Deno.serve((req: Request) => {
  const env = (k: string) => Deno.env.get(k);
  return handle(req, {
    sb: createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }),
    push: webpush,
    now: () => Date.now(),
    env,
    prepare: () => webpush.setVapidDetails(env("VAPID_SUBJECT") ?? "mailto:admin@example.com", env("VAPID_PUBLIC_KEY")!, env("VAPID_PRIVATE_KEY")!),
  });
});

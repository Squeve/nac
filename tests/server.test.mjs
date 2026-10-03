// Unit tests for the reminder sender (supabase/functions/send-reminders) and the key generator page.
// Run:  node --experimental-strip-types tests/server.test.mjs      (needs Node 22+ and:  npm install web-push@3.6.7)
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert'; import crypto from 'crypto'; import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/send-reminders/index.ts'), 'utf8');

// make the Edge Function loadable in Node: swap the two Deno-only imports and the Deno global for stand-ins
let served = null;
globalThis.Deno = { env: { get: () => undefined }, serve: (fn) => { served = fn; } };
globalThis.__createClient = () => ({}); globalThis.__webpush = { setVapidDetails() {} };
const patched = src
  .replace(/^import \{ createClient \} from "npm:[^"]+";$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import webpush from "npm:[^"]+";$/m, 'const webpush = globalThis.__webpush;');
assert(patched !== src && !/npm:/.test(patched), 'imports were not swapped');
const tmp = path.join(os.tmpdir(), 'send-reminders.test.mts');
fs.writeFileSync(tmp, patched);
const m = await import(pathToFileURL(tmp).href);

let pass = 0; const t = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('PASS ', name); }, (e) => { console.log('FAIL ', name, '->', e.message); process.exitCode = 1; });

// ── fake database ──
function makeDb({ schedules = [], subs = [], sent = [] } = {}) {
  const db = { schedules, subs, sent: new Set(sent), deletedSubs: [] };
  db.from = (table) => ({
    select: () => { const rows = table === 'push_schedule' ? db.schedules : db.subs; const p = Promise.resolve({ data: rows, error: null });
      p.eq = (c, v) => Promise.resolve({ data: rows.filter((r) => r[c] === v), error: null }); return p; },
    insert: (row) => Promise.resolve(db.sent.has(row.key) ? { error: { message: 'duplicate key' } } : (db.sent.add(row.key), { error: null })),
    delete: () => ({
      lt: () => Promise.resolve({ error: null }),
      eq: (c, v) => { if (table === 'push_sent') db.sent.delete(v); else { db.deletedSubs.push(v); db.subs = db.subs.filter((s) => s[c] !== v); } return Promise.resolve({ error: null }); }
    })
  });
  return db;
}
function makePush(failWith = {}) {
  const p = { calls: [], sendNotification: async (sub, payload, opts) => { p.calls.push({ sub, payload: JSON.parse(payload), opts }); if (failWith[sub.endpoint]) throw Object.assign(new Error('push failed'), { statusCode: failWith[sub.endpoint] }); } };
  return p;
}
const NOW = Date.UTC(2026, 9, 2, 8, 0, 30);
const req = (secret) => new Request('https://x/f', { method: 'POST', headers: secret ? { 'x-cron-secret': secret } : {} });
const run = async (db, push, secret = 's3cret') => { const r = await m.handle(req(secret), { sb: db, push, now: () => NOW, env: (k) => (k === 'CRON_SECRET' ? 's3cret' : undefined), prepare() {} }); return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() }; };
const item = (o = {}) => ({ k: 'm-2026-10-02', at: NOW - 30000, title: '☀️ 3 PTPs due today', body: 'Expected ₵4,200', tag: 'ptp-morning', url: '?notif=ptp', ...o });
const S = (e) => ({ endpoint: e, p256dh: 'p', auth: 'a', agent_id: 'A' });

await t('pickDue: only items that are due now and not older than 20 min', () => {
  const items = [item({ k: 'due' }), item({ k: 'future', at: NOW + 60000 }), item({ k: 'late', at: NOW - 21 * 60000 }), item({ k: 'edge', at: NOW - 20 * 60000 })];
  assert.deepStrictEqual(m.pickDue(items, NOW).map((i) => i.k), ['due', 'edge']);
});
await t('pickDue: ignores junk and cleans unsafe tag/url', () => {
  const r = m.pickDue([null, 5, 'x', { k: 1 }, { k: 'a', at: 'now', title: 't' }, item({ k: 'bad', tag: '<script>', url: 'https://evil.example' })], NOW);
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].tag, 'sq-reminder'); assert.strictEqual(r[0].url, '?notif=ptp');
  assert.deepStrictEqual(m.pickDue('nope', NOW), []);
});
await t('rejects calls without the secret (no database access, nothing sent)', async () => {
  const db = makeDb({ schedules: [{ agent_id: 'A', items: [item()] }], subs: [S('e1')] }), push = makePush();
  for (const sec of [null, 'wrong']) { const r = await run(db, push, sec); assert.strictEqual(r.status, 403); }
  assert.strictEqual(push.calls.length, 0);
});
await t('sends a due alert to every device of the agent, with the right payload and a 15-min TTL', async () => {
  const db = makeDb({ schedules: [{ agent_id: 'A', items: [item()] }], subs: [S('e1'), S('e2'), { ...S('other'), agent_id: 'B' }] }), push = makePush();
  const r = await run(db, push); assert.strictEqual(r.body.sent, 2);
  assert.deepStrictEqual(push.calls.map((c) => c.sub.endpoint).sort(), ['e1', 'e2']);
  assert.deepStrictEqual(push.calls[0].payload, { title: '☀️ 3 PTPs due today', body: 'Expected ₵4,200', tag: 'ptp-morning', url: '?notif=ptp' });
  assert.strictEqual(push.calls[0].opts.TTL, 900);
});
await t('never sends the same alert twice (second run, and two runs at once)', async () => {
  const db = makeDb({ schedules: [{ agent_id: 'A', items: [item()] }], subs: [S('e1')] }), push = makePush();
  await run(db, push); const r2 = await run(db, push);
  assert.strictEqual(push.calls.length, 1); assert.strictEqual(r2.body.skipped, 1);
  const db2 = makeDb({ schedules: [{ agent_id: 'A', items: [item()] }], subs: [S('e1')] }), push2 = makePush();
  await Promise.all([run(db2, push2), run(db2, push2)]); assert.strictEqual(push2.calls.length, 1);
});
await t('future and too-old alerts are not sent', async () => {
  const db = makeDb({ schedules: [{ agent_id: 'A', items: [item({ k: 'f', at: NOW + 5000 }), item({ k: 'o', at: NOW - 3600000 })] }], subs: [S('e1')] }), push = makePush();
  await run(db, push); assert.strictEqual(push.calls.length, 0); assert.strictEqual(db.sent.size, 0);
});
await t('an expired device (410) is removed; the other device still gets the alert', async () => {
  const db = makeDb({ schedules: [{ agent_id: 'A', items: [item()] }], subs: [S('dead'), S('live')] }), push = makePush({ dead: 410 });
  const r = await run(db, push); assert.strictEqual(r.body.removed, 1); assert.strictEqual(r.body.sent, 1);
  assert.deepStrictEqual(db.deletedSubs, ['dead']); assert.ok(db.sent.size === 1);
});
await t('if nobody could be reached (server error) the alert is retried on the next run', async () => {
  const db = makeDb({ schedules: [{ agent_id: 'A', items: [item()] }], subs: [S('e1')] });
  const bad = makePush({ e1: 500 }); await run(db, bad); assert.strictEqual(db.sent.size, 0);
  const good = makePush(); await run(db, good); assert.strictEqual(good.calls.length, 1);
});
await t('an agent with no registered device is skipped without marking anything sent', async () => {
  const db = makeDb({ schedules: [{ agent_id: 'A', items: [item()] }], subs: [] }), push = makePush();
  await run(db, push); assert.strictEqual(push.calls.length, 0); assert.strictEqual(db.sent.size, 0);
});

// ── the key generator page really produces keys web-push accepts and can sign with ──
await t('vapid-keys.html: generated keys are valid for web-push (encrypts, signs a JWT that verifies)', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'tools/vapid-keys.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const { makeVapidKeys } = new Function('crypto', 'btoa', 'document', code + '; return { makeVapidKeys };')(crypto.webcrypto, (s) => Buffer.from(s, 'binary').toString('base64'), undefined);
  const k = await makeVapidKeys();
  assert.strictEqual(Buffer.from(k.publicKey, 'base64url').length, 65); assert.strictEqual(Buffer.from(k.privateKey, 'base64url').length, 32);
  assert(!/[+/=]/.test(k.publicKey + k.privateKey), 'must be base64url');
  const webpush = (await import('web-push')).default; webpush.setVapidDetails('mailto:test@example.com', k.publicKey, k.privateKey);
  const dev = crypto.createECDH('prime256v1'); dev.generateKeys();
  const d = webpush.generateRequestDetails({ endpoint: 'https://push.example.com/abc', keys: { p256dh: dev.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }, JSON.stringify({ title: 'x' }), { TTL: 900 });
  const auth = d.headers.Authorization; const jwt = auth.match(/t=([^,]+)/)[1]; const [h, p, sig] = jwt.split('.');
  const pub = await crypto.webcrypto.subtle.importKey('raw', Buffer.from(k.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert(await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(sig, 'base64url'), Buffer.from(h + '.' + p)), 'JWT signature must verify with the public key');
  assert.strictEqual(JSON.parse(Buffer.from(p, 'base64url').toString()).aud, 'https://push.example.com');
});
console.log(`\n${pass} server checks passed`);

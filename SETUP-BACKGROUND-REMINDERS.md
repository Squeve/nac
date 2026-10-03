# Background reminders: one-time setup

**What this adds.** Today your PTP alerts are timers inside the open app, so they stop when the app is closed or the
phone is locked. With this set up, a small job on Supabase sends the same alerts (15 minutes before a promise, the 08:00
brief, the 17:00 check) to your phone **even when the app is closed**.

**Nothing changes until you finish these steps.** Until `push-config.json` has a key, the app behaves exactly as it does
now. Do the steps in order. It takes about 20 minutes and costs nothing on Supabase's free plan (it makes roughly 43,000
function calls a month; the free allowance is far higher, but check your plan's current limits).

---

## 1. Make your two keys (2 min)

1. Open **`tools/vapid-keys.html`** from the downloaded files by double-clicking it (do not upload it to GitHub).
2. Press **Generate keys**. Copy the **public key** and the **private key** into a notes app for the next steps.
   The private key is like a password. Never put it in GitHub or in the app.

## 2. Put the public key in the app (2 min)

1. In your GitHub repo open **`push-config.json`** → pencil icon (Edit).
2. Paste the public key between the quotes: `{ "vapidPublicKey": "BExample..." }` → **Commit changes**.
   (If the file isn't in the repo yet, upload it with the other new files first.)

## 3. Create the database tables (3 min)

1. Supabase dashboard → **SQL Editor** → **New query**.
2. Paste the whole of **`supabase/setup.sql`** → **Run**. It should finish with "Success".

This locks three new tables so the app's public key cannot read or write them directly. The app can only use three
checked "doors" (`register_push`, `unregister_push`, `set_push_schedule`).

## 4. Create the sender function (8 min)

1. Dashboard → **Edge Functions** → **Create a new function**. Name it exactly **`send-reminders`**.
2. Replace the starter code with the whole of **`supabase/functions/send-reminders/index.ts`** → **Deploy**.
3. Dashboard → **Edge Functions → Secrets** (or **Project Settings → Edge Functions**). Add these four:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the public key from step 1 |
| `VAPID_PRIVATE_KEY` | the private key from step 1 |
| `VAPID_SUBJECT` | `mailto:` plus your email, e.g. `mailto:you@example.com` |
| `CRON_SECRET` | any long random text (mash the keyboard for 30+ characters); save it, you need it in step 5 |

(`SUPABASE_URL` and the service key are provided to the function automatically. Menu names in the dashboard move around
a little between versions. If one is missing, look for "Edge Functions" and "Secrets".)

## 5. Make it run every minute (3 min)

1. SQL Editor → **New query**. Open **`supabase/cron.sql`**, replace `<ANON-KEY>` with the public "anon" key already in
   your `index.html` (Supabase → Project Settings → API) and `<CRON-SECRET>` with the `CRON_SECRET` from step 4.
2. **Run**. (If it says an extension must be enabled, enable **pg_cron** and **pg_net** under Database → Extensions and run it again.)

## 6. Deploy the app and test (5 min)

1. Upload the new files to GitHub as usual (`index.html`, `sw.js`, `tests/…`, workflow). Wait for the green tick.
2. Open the app on your phone → tap once when asked to **allow notifications**.
3. **Settings → Diagnostics** should show **Background reminders: on · N upcoming alerts on the server**.
4. Tap **Test background alert**, then **close the app completely** (swipe it away). Within about a minute a
   notification "✅ Background reminders work" should arrive.
5. Real test: set a promise ~20 minutes from now, close the app, and wait for "promise in 15 min".

## If something doesn't work

| Symptom | Likely cause |
|---|---|
| Diagnostics says **not set up** | the public key isn't in `push-config.json` yet (or GitHub hasn't deployed it) |
| Diagnostics says **ERROR: unknown device / function does not exist** | step 3 wasn't run, or ran with an error |
| Test alert never arrives | open **Edge Functions → send-reminders → Logs**. A `403` means `CRON_SECRET` differs between step 4 and step 5; a `500` usually means a VAPID secret is missing or mistyped |
| Works on Android, not on iPhone | iPhone only supports push for apps **installed to the Home Screen** (iOS 16.4+) |
| Stopped working after weeks of not using the app | free Supabase projects can pause when unused. Open the Supabase dashboard and resume it |

**To switch it off:** turn reminders off in PTP Hub → Morning (that removes your phone from the server), or stop the job
for everyone with `select cron.unschedule('send-reminders');`.

## What you should know

- **Same trust level as your current sync.** Your app talks to Supabase with a public key, so anyone who finds a
  device's push address could register their own device for an agent ID. The new tables are locked down and the
  checks are strict, but the real fix for all of it is Supabase sign-in. Do the Row Level Security check on the
  `app_state` table too.
- **Alert text is stored on Supabase.** The upcoming alerts (borrower first names, amounts) sit in `push_schedule`
  for the next 72 hours. They travel to your phone encrypted. Your phone's lock screen will show them like the
  current ones do.
- **When the app is open on screen**, the server stays quiet and the app's own alarms show the alert, so you never
  get it twice.
- **The 17:00 alert is a nudge** ("EOD check: N PTPs today") because only the open app knows the day's final tally.
  When the app is open at 17:00 you still get the full "honoured / total" summary as before.
- **The alert fires up to a minute late at most**, and is dropped if it would arrive more than 20 minutes late.

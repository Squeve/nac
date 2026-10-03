-- ─────────────────────────────────────────────────────────────────────────────
-- SqueveTrack — run the reminder sender every minute        run ONCE, AFTER deploying the function
-- Replace the three <...> placeholders first.
--   <ANON-KEY>     the public "anon" key already inside index.html (Settings → API in Supabase)
--   <CRON-SECRET>  the same random text you saved as the CRON_SECRET function secret
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- (re-running? remove the old job first:  select cron.unschedule('send-reminders'); )
select cron.schedule(
  'send-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://bbjpifrkzvzskwvjbhot.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <ANON-KEY>',
                 'x-cron-secret', '<CRON-SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

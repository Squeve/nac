-- ─────────────────────────────────────────────────────────────────────────────
-- SqueveTrack — background reminders (Web Push)            run ONCE in Supabase → SQL Editor
-- Safe to run again: everything uses "if not exists" / "create or replace".
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per phone/laptop that has switched reminders on
create table if not exists public.push_subscriptions (
  endpoint   text primary key,                 -- the device's private push address (acts like a password)
  agent_id   text not null,                    -- which agent this device belongs to
  p256dh     text not null,
  auth       text not null,
  tz         text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index if not exists push_subscriptions_agent_idx on public.push_subscriptions (agent_id);

-- The upcoming alerts each agent's app has worked out (same text the on-device alarms use)
create table if not exists public.push_schedule (
  agent_id   text primary key,
  items      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Remembers what was already sent so nothing goes out twice
create table if not exists public.push_sent (
  key     text primary key,
  sent_at timestamptz not null default now()
);

-- Lock the tables: the app's public key can NOT read or write them directly.
-- (With RLS on and no policies, only the server-side function — which uses the service key — can.)
alter table public.push_subscriptions enable row level security;
alter table public.push_schedule      enable row level security;
alter table public.push_sent          enable row level security;

-- The only doors the app can use, each with strict checks ─────────────────────
create or replace function public.register_push(
  p_agent text, p_endpoint text, p_p256dh text, p_auth text, p_tz text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_agent !~ '^[A-Za-z0-9_-]{1,64}$'                    then raise exception 'bad agent';    end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 700 then raise exception 'bad endpoint'; end if;
  if length(p_p256dh) > 200 or length(p_auth) > 100        then raise exception 'bad keys';     end if;
  insert into public.push_subscriptions (endpoint, agent_id, p256dh, auth, tz)
  values (p_endpoint, p_agent, p_p256dh, p_auth, left(p_tz, 64))
  on conflict (endpoint) do update
    set agent_id = excluded.agent_id, p256dh = excluded.p256dh, auth = excluded.auth,
        tz = excluded.tz, last_seen = now();
end $$;

create or replace function public.unregister_push(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint;
$$;

create or replace function public.set_push_schedule(p_agent text, p_endpoint text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_agent !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad agent'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 60 then raise exception 'bad items'; end if;
  -- only a device that registered for this agent may change that agent's schedule
  if not exists (select 1 from public.push_subscriptions where endpoint = p_endpoint and agent_id = p_agent) then
    raise exception 'unknown device';
  end if;
  insert into public.push_schedule (agent_id, items, updated_at) values (p_agent, p_items, now())
  on conflict (agent_id) do update set items = excluded.items, updated_at = now();
  update public.push_subscriptions set last_seen = now() where endpoint = p_endpoint;
end $$;

revoke all on function public.register_push(text, text, text, text, text)  from public;
revoke all on function public.unregister_push(text)                         from public;
revoke all on function public.set_push_schedule(text, text, jsonb)          from public;
grant execute on function public.register_push(text, text, text, text, text) to anon, authenticated;
grant execute on function public.unregister_push(text)                        to anon, authenticated;
grant execute on function public.set_push_schedule(text, text, jsonb)         to anon, authenticated;

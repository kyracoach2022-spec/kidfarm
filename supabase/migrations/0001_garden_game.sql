-- Zana Little Garden backend tables, applied to the ZANA DYNASTY COS (ERP) Supabase project
-- (project ref gxycxjksrzjzxzgbblup) — NOT the Marketing OS database that
-- the Marketing OS repo targets. Explicit user decision: the game is hosted on Netlify
-- (site kyrakidsquiz) and stores players/coupons in the ERP database.
--
-- Every table here has RLS ON and no policies: only the `garden` Edge Function
-- (supabase/functions/garden, service role) reads or writes them. The public game page never
-- holds a Supabase key.

create table if not exists garden_players (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  display_name text not null,
  phone text not null unique,
  line_id text,
  channel text not null default 'other',
  consent_terms_at timestamptz not null,
  consent_marketing boolean not null default false,
  level int not null default 1,
  harvested int not null default 0,
  play_seconds int not null default 0,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists garden_players_token_hash_idx on garden_players (token_hash);

create table if not exists garden_rewards (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references garden_players (id) on delete cascade,
  milestone int not null,
  code text not null unique,
  discount_label text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  redeemed_note text,
  unique (player_id, milestone)
);

-- Coupon ladder. Edit rows in the Supabase Table Editor to change rewards — no redeploy.
-- min_minutes = minimum time since registration before the coupon can be issued (anti-cheat).
create table if not exists garden_milestones (
  level int primary key,
  label text not null,
  min_minutes int not null default 0,
  valid_days int not null default 30
);
insert into garden_milestones (level, label, min_minutes, valid_days) values
  (3, 'ส่วนลด 5%', 10, 30),
  (5, 'ส่วนลด 10%', 30, 30),
  (8, 'ส่วนลด 15%', 90, 45)
on conflict (level) do nothing;

-- key/value settings; staff_pin_hash = sha256 hex of the staff PIN (set separately, never committed).
create table if not exists garden_config (
  key text primary key,
  value text not null
);

alter table garden_players enable row level security;
alter table garden_rewards enable row level security;
alter table garden_milestones enable row level security;
alter table garden_config enable row level security;

-- Which of these player phones already exist in the ERP customers table (any formatting).
-- Service role only: exposing it would let anyone probe whether a phone is a customer.
create or replace function public.garden_matching_customers(phones text[])
returns table (phone text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct p
  from unnest(phones) as p
  where exists (
    select 1 from customers c
    where regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') in (p, '66' || substr(p, 2), substr(p, 2))
  );
$$;
revoke all on function public.garden_matching_customers(text[]) from public, anon, authenticated;
grant execute on function public.garden_matching_customers(text[]) to service_role;

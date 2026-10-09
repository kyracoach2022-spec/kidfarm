-- Access codes for Zana Little Garden (explicit user request: one public link with no ?src,
-- customers get an access code with their purchase). A new phone number can only register with
-- a valid code; the code carries the sales channel, so players no longer pick one. Staff create
-- codes from /staff. RLS on, no policies — only the `garden` Edge Function touches this table.
create table if not exists garden_access_codes (
  code text primary key,
  channel text not null default 'other',
  batch text,
  max_uses int not null default 1 check (max_uses >= 1),
  uses int not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table garden_access_codes enable row level security;
alter table garden_players add column if not exists access_code text references garden_access_codes (code);

-- Atomically consume one use of a code; returns the code's channel, or null when the code is
-- unknown or used up. Service role only.
create or replace function public.garden_use_access_code(p_code text)
returns text
language sql
security definer
set search_path = public
as $$
  update garden_access_codes
     set uses = uses + 1, last_used_at = now()
   where code = upper(trim(p_code)) and uses < max_uses
  returning channel;
$$;
revoke all on function public.garden_use_access_code(text) from public, anon, authenticated;
grant execute on function public.garden_use_access_code(text) to service_role;

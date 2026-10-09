-- Online-game style accounts (explicit user request): a customer redeems an access code once, is
-- forced to pick their own USER ID + password, then signs in with those on any device. Game state is
-- saved to the server (save_data) so the farm follows the account. Forgotten passwords: the customer
-- sends their USER ID to admin, who issues a temporary password from /staff (must_change_password
-- forces a new one at next sign-in). Passwords are PBKDF2-SHA256 hashed in the Edge Function; the
-- plaintext is never stored, so admins reset rather than read them.
alter table garden_players add column if not exists username text;
create unique index if not exists garden_players_username_key on garden_players (lower(username));
alter table garden_players add column if not exists password_hash text;
alter table garden_players add column if not exists must_change_password boolean not null default false;
alter table garden_players add column if not exists save_data jsonb;
alter table garden_players add column if not exists save_at timestamptz;
alter table garden_players add column if not exists failed_logins int not null default 0;
alter table garden_players add column if not exists locked_until timestamptz;

-- One row per signed-in device, so an account can stay signed in on a phone and a tablet at once.
create table if not exists garden_sessions (
  token_hash text primary key,
  player_id uuid not null references garden_players (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists garden_sessions_player_idx on garden_sessions (player_id);
alter table garden_sessions enable row level security;

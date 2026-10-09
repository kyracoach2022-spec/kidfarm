-- Team access codes (explicit user request): a GM/host code that starts with everything unlocked,
-- and an admin/tester code for the team to test every system. Both roles get coupons immediately
-- (no min_minutes wait) but those coupons are flagged is_test and labelled "ทดสอบ", and team players
-- are excluded from customer stats on the staff page.
alter table garden_access_codes add column if not exists role text not null default 'player'
  check (role in ('player', 'gm', 'tester'));
alter table garden_players add column if not exists role text not null default 'player'
  check (role in ('player', 'gm', 'tester'));
alter table garden_rewards add column if not exists is_test boolean not null default false;

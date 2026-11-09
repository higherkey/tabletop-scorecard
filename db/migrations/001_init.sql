-- Tabletop Scorecard v2 cloud schema. Idempotent: safe to re-run.

create table if not exists public.schema_migrations (
  version text primary key,
  applied_at timestamptz default now()
);

create table if not exists public.games (
  id uuid primary key,
  user_id text not null default auth.user_id(),
  data jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  share_token text unique check (share_token ~ '^[A-Za-z0-9_-]{22}$'),
  server_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (deleted_at is not null or data is not null),
  check (data is null or pg_column_size(data) < 262144)
);
create index if not exists games_user_sync_idx on public.games (user_id, server_updated_at);

create table if not exists public.players (
  user_id text not null default auth.user_id(),
  key text not null check (key = lower(btrim(name))),
  name text not null check (char_length(btrim(name)) between 1 and 30),
  color smallint not null check (color between 0 and 7),
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists players_user_sync_idx on public.players (user_id, server_updated_at);

create table if not exists public.user_settings (
  user_id text primary key default auth.user_id(),
  data jsonb not null check (pg_column_size(data) < 8192),
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now()
);

-- Server-side last-writer-wins guard; the owner can never change.
create or replace function public.touch_and_guard() returns trigger
language plpgsql
as $$
begin
  NEW.server_updated_at := now();
  if TG_OP = 'UPDATE' then
    if NEW.updated_at < OLD.updated_at then
      return null;
    end if;
    NEW.user_id := OLD.user_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists games_touch_and_guard on public.games;
create trigger games_touch_and_guard before insert or update on public.games
  for each row execute function public.touch_and_guard();
drop trigger if exists players_touch_and_guard on public.players;
create trigger players_touch_and_guard before insert or update on public.players
  for each row execute function public.touch_and_guard();
drop trigger if exists user_settings_touch_and_guard on public.user_settings;
create trigger user_settings_touch_and_guard before insert or update on public.user_settings
  for each row execute function public.touch_and_guard();

alter table public.games enable row level security;
alter table public.games force row level security;
alter table public.players enable row level security;
alter table public.players force row level security;
alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;

drop policy if exists games_owner on public.games;
create policy games_owner on public.games for all to authenticated
  using (user_id = auth.user_id()) with check (user_id = auth.user_id());
drop policy if exists players_owner on public.players;
create policy players_owner on public.players for all to authenticated
  using (user_id = auth.user_id()) with check (user_id = auth.user_id());
drop policy if exists user_settings_owner on public.user_settings;
create policy user_settings_owner on public.user_settings for all to authenticated
  using (user_id = auth.user_id()) with check (user_id = auth.user_id());

-- Grants: explicit; nothing on the tables for anonymous.
grant usage on schema public to anonymous, authenticated;
revoke all on public.games, public.players, public.user_settings, public.schema_migrations from anonymous;
revoke all on public.schema_migrations from authenticated;
grant select, insert, update, delete on public.games, public.players, public.user_settings to authenticated;

-- Public read of one shared game by its unguessable token.
create or replace function public.get_shared_game(p_token text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('game', g.data, 'updatedAt', g.server_updated_at)
  from public.games g
  where g.share_token = p_token
    and g.deleted_at is null
    and p_token ~ '^[A-Za-z0-9_-]{22}$'
$$;
revoke execute on function public.get_shared_game(text) from public;
grant execute on function public.get_shared_game(text) to anonymous, authenticated;

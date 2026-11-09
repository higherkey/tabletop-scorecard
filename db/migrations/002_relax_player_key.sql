-- Relax players.key: it is the client-side lowercase name key, which can differ from
-- lower(btrim(name)) once names are truncated by code points. Idempotent: safe to re-run.

do $$
declare
  c record;
begin
  -- Drop the old key = lower(btrim(name)) check, found by definition (the name is auto-generated).
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.players'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%lower%btrim%name%'
  loop
    execute format('alter table public.players drop constraint %I', c.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.players'::regclass and conname = 'players_key_length_check'
  ) then
    alter table public.players
      add constraint players_key_length_check check (char_length(key) between 1 and 120);
  end if;
end
$$;

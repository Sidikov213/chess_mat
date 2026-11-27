-- Добавка 3: наблюдение за партиями в админке. Выполнить целиком в Supabase → SQL Editor → Run
-- (после schema.sql и 002_names.sql). Можно запускать повторно.
--
-- После каждого хода сайт добавляет строку с текущей позицией: доска, ходы, часы.
-- Посетители могут только добавлять строки, читать — только админ.

create table if not exists public.cc_moves (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  game_id     uuid not null,
  visitor_id  uuid not null,
  ply         int  not null check (ply between 0 and 2000),
  fen         text not null check (char_length(fen) <= 100),
  last_uci    text check (char_length(last_uci) <= 6),
  sans        text not null default '' check (char_length(sans) <= 8000),  -- ходы через пробел
  clock_white int  check (clock_white between 0 and 36000000),            -- осталось, мс; null — без часов
  clock_black int  check (clock_black between 0 and 36000000)
);
create index if not exists cc_moves_game on public.cc_moves (game_id, id desc);
create index if not exists cc_moves_ts on public.cc_moves (ts);
create index if not exists cc_events_game on public.cc_events (game_id) where game_id is not null;

revoke all on public.cc_moves from anon, authenticated, public;
grant insert (game_id, visitor_id, ply, fen, last_uci, sans, clock_white, clock_black) on public.cc_moves to anon, authenticated;
grant select on public.cc_moves to authenticated;
alter table public.cc_moves enable row level security;
drop policy if exists cc_moves_insert on public.cc_moves;
drop policy if exists cc_moves_read   on public.cc_moves;
create policy cc_moves_insert on public.cc_moves for insert to anon, authenticated with check (true);
create policy cc_moves_read   on public.cc_moves for select to authenticated using (public.cc_is_admin());

-- Кто сейчас играет: партии с ходом за последние minutes минут, ещё не законченные.
create or replace function public.cc_live(minutes int default 15) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.cc_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with last as (
    select distinct on (game_id) *
    from cc_moves
    where ts > now() - make_interval(mins => least(greatest(minutes, 1), 1440))
    order by game_id, id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'game_id', l.game_id, 'visitor_id', l.visitor_id, 'ts', l.ts, 'ply', l.ply, 'fen', l.fen,
           'last_uci', l.last_uci, 'clock_white', l.clock_white, 'clock_black', l.clock_black,
           'name', (select e.data->>'name' from cc_events e
                     where e.visitor_id = l.visitor_id and e.data ? 'name' order by e.ts desc limit 1),
           'info', (select e.data from cc_events e
                     where e.game_id = l.game_id and e.kind = 'game_start' order by e.ts limit 1)
         ) order by l.ts desc), '[]'::jsonb)
  into r
  from last l
  where not exists (select 1 from cc_games g where g.id = l.game_id);
  return r;
end $$;

revoke all on function public.cc_live(int) from public, anon;
grant execute on function public.cc_live(int) to authenticated;

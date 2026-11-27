-- Статистика сайта Chess Coach. Выполнить целиком в Supabase → SQL Editor → Run.
-- Можно запускать повторно: всё создаётся «если нет», права выставляются заново.
--
-- Кто что может:
--   посетитель сайта (роль anon, ключ publishable) — только ДОБАВЛЯТЬ строки, читать не может;
--   админ (вошёл на admin.html и записан в cc_admins) — читать.
-- Изменять и удалять строки через API не может никто.

-- ---------- таблицы ----------

create table if not exists public.cc_events (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),
  visitor_id uuid not null,
  session_id uuid not null,
  kind       text not null check (kind in ('visit', 'game_start', 'clip', 'name')),
  game_id    uuid,
  data       jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 2000)
);
create index if not exists cc_events_ts on public.cc_events (ts);
create index if not exists cc_events_visitor on public.cc_events (visitor_id, ts);

create table if not exists public.cc_games (
  id           uuid primary key,              -- тот же game_id, что в событии game_start
  ts           timestamptz not null default now(),   -- когда закончилась
  visitor_id   uuid not null,
  mode         text not null check (mode in ('bot', 'local', 'net')),
  bot_id       text check (char_length(bot_id) <= 40),
  bot_name     text check (char_length(bot_name) <= 60),
  bot_elo      int  check (bot_elo between 0 and 4000),
  color        text check (color in ('white', 'black')),
  time_control text check (char_length(time_control) <= 40),
  chess960     boolean not null default false,
  -- против бота: win | loss | draw (с точки зрения игрока); вдвоём: white | black | draw
  result       text not null check (result in ('win', 'loss', 'draw', 'white', 'black')),
  how          text check (how in ('mate', 'time', 'resign', 'draw', 'other')),
  reason       text check (char_length(reason) <= 120),
  opening      text check (char_length(opening) <= 120),
  plies        int  check (plies between 0 and 2000),
  accuracy     int  check (accuracy between 0 and 100),
  blunders     int  check (blunders between 0 and 1000),
  mistakes     int  check (mistakes between 0 and 1000),
  inaccuracies int  check (inaccuracies between 0 and 1000),
  duration_s   int  check (duration_s between 0 and 864000),
  player_name  text check (char_length(player_name) <= 40)
);
create index if not exists cc_games_visitor on public.cc_games (visitor_id, ts);
create index if not exists cc_games_ts on public.cc_games (ts);

create table if not exists public.cc_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- ---------- кто админ ----------

create or replace function public.cc_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cc_admins where user_id = auth.uid());
$$;

-- ---------- права: всё отнять, выдать только нужное ----------

revoke all on public.cc_events, public.cc_games, public.cc_admins from anon, authenticated, public;
grant insert (visitor_id, session_id, kind, game_id, data) on public.cc_events to anon, authenticated;
grant insert (id, visitor_id, mode, bot_id, bot_name, bot_elo, color, time_control, chess960, result,
              how, reason, opening, plies, accuracy, blunders, mistakes, inaccuracies, duration_s, player_name)
  on public.cc_games to anon, authenticated;
grant select on public.cc_events, public.cc_games to authenticated;

alter table public.cc_events enable row level security;
alter table public.cc_games  enable row level security;
alter table public.cc_admins enable row level security;   -- политик нет: через API недоступна никому

drop policy if exists cc_events_insert on public.cc_events;
drop policy if exists cc_events_read   on public.cc_events;
drop policy if exists cc_games_insert  on public.cc_games;
drop policy if exists cc_games_read    on public.cc_games;
create policy cc_events_insert on public.cc_events for insert to anon, authenticated with check (true);
create policy cc_events_read   on public.cc_events for select to authenticated using (public.cc_is_admin());
create policy cc_games_insert  on public.cc_games  for insert to anon, authenticated with check (true);
create policy cc_games_read    on public.cc_games  for select to authenticated using (public.cc_is_admin());

revoke all on function public.cc_is_admin() from public, anon;
grant execute on function public.cc_is_admin() to authenticated;

-- ---------- сводка для админки (одним запросом) ----------

create or replace function public.cc_summary(tz text default 'Europe/Moscow') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  today timestamptz := date_trunc('day', now() at time zone tz) at time zone tz;
  r jsonb;
begin
  if not public.cc_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with first_seen as (
    select visitor_id, min(ts) as first_ts from cc_events group by visitor_id
  ),
  periods(key, since) as (
    values ('today', today), ('week', today - interval '6 days'),
           ('month', today - interval '29 days'), ('all', '-infinity'::timestamptz)
  ),
  visitors as (
    select p.key,
           count(distinct e.visitor_id) as visitors,
           count(distinct e.visitor_id) filter (where f.first_ts >= p.since) as new_visitors,
           count(*) filter (where e.kind = 'visit') as visits
    from periods p
    left join cc_events e on e.ts >= p.since
    left join first_seen f on f.visitor_id = e.visitor_id
    group by p.key
  ),
  games as (
    select p.key,
           (select count(*) from cc_events e where e.kind = 'game_start' and e.ts >= p.since) as started,
           (select count(*) from cc_games g where g.ts >= p.since) as finished,
           (select count(*) from cc_events e where e.kind = 'clip' and e.ts >= p.since) as clips
    from periods p
  ),
  days as (
    select d::date as day,
           (select count(distinct visitor_id) from cc_events e
             where e.ts >= d at time zone tz and e.ts < (d + interval '1 day') at time zone tz) as visitors,
           (select count(*) from cc_events e where e.kind = 'game_start'
             and e.ts >= d at time zone tz and e.ts < (d + interval '1 day') at time zone tz) as started,
           (select count(*) from cc_games g
             where g.ts >= d at time zone tz and g.ts < (d + interval '1 day') at time zone tz) as finished
    from generate_series((now() at time zone tz)::date - 29, (now() at time zone tz)::date, interval '1 day') d
  ),
  bots as (
    select coalesce(s.bot_id, g.bot_id) as bot_id,
           coalesce(max(g.bot_name), max(s.bot_name)) as bot_name,
           coalesce(max(s.started), 0) as started,
           count(g.id) as finished,
           count(g.id) filter (where g.result = 'win')  as player_wins,
           count(g.id) filter (where g.result = 'draw') as draws,
           count(g.id) filter (where g.result = 'loss') as bot_wins,
           round(avg(g.accuracy)) as avg_accuracy
    from (select data->>'bot_id' as bot_id, max(data->>'bot_name') as bot_name, count(*) as started
            from cc_events where kind = 'game_start' and data->>'mode' = 'bot' group by 1) s
    full join (select * from cc_games where mode = 'bot') g on g.bot_id = s.bot_id
    group by 1
  ),
  sources as (
    select coalesce(nullif(data->>'source', ''), 'прямой заход') as source, count(*) as visits
    from cc_events where kind = 'visit' and ts >= today - interval '29 days'
    group by 1 order by 2 desc limit 15
  ),
  names as (
    select distinct on (visitor_id) visitor_id, data->>'name' as name
    from cc_events where data->>'name' is not null and data->>'name' <> ''
    order by visitor_id, ts desc
  ),
  players as (
    select v.visitor_id,
           n.name,
           min(v.ts) as first_ts,
           max(v.ts) as last_ts,
           (select count(*) from cc_games g where g.visitor_id = v.visitor_id) as games,
           (select count(*) from cc_games g where g.visitor_id = v.visitor_id and g.result = 'win') as wins,
           (select count(*) from cc_games g where g.visitor_id = v.visitor_id and g.mode = 'bot') as bot_games
    from cc_events v left join names n using (visitor_id)
    group by v.visitor_id, n.name
    order by max(v.ts) desc
    limit 100
  ),
  devices as (
    select coalesce(data->>'device', '?') as device, count(distinct visitor_id) as visitors
    from cc_events where kind = 'visit' and ts >= today - interval '29 days'
    group by 1 order by 2 desc
  )
  select jsonb_build_object(
    'generated_at', now(),
    'periods', (select jsonb_object_agg(v.key, jsonb_build_object(
                  'visitors', v.visitors, 'new_visitors', v.new_visitors, 'visits', v.visits,
                  'games_started', g.started, 'games_finished', g.finished, 'clips', g.clips))
                from visitors v join games g using (key)),
    'days',    (select jsonb_agg(to_jsonb(days) order by day) from days),
    'bots',    (select coalesce(jsonb_agg(to_jsonb(bots) order by started desc), '[]') from bots),
    'modes',   (select coalesce(jsonb_object_agg(mode, n), '{}') from
                 (select mode, count(*) n from cc_games group by mode) m),
    'sources', (select coalesce(jsonb_agg(to_jsonb(sources)), '[]') from sources),
    'devices', (select coalesce(jsonb_agg(to_jsonb(devices)), '[]') from devices),
    'players', (select coalesce(jsonb_agg(to_jsonb(players) order by last_ts desc), '[]') from players)
  ) into r;
  return r;
end $$;

revoke all on function public.cc_summary(text) from public, anon;
grant execute on function public.cc_summary(text) to authenticated;

-- ---------- наблюдение за партиями (как supabase/003_live.sql) ----------

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

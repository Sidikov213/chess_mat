-- Добавка 2: имена игроков. Выполнить целиком в Supabase → SQL Editor → Run (после schema.sql).
-- Можно запускать повторно.

-- новое событие «игрок ввёл имя»
alter table public.cc_events drop constraint if exists cc_events_kind_check;
alter table public.cc_events add constraint cc_events_kind_check check (kind in ('visit', 'game_start', 'clip', 'name'));

-- имя в каждой партии (каким оно было в момент игры)
alter table public.cc_games add column if not exists player_name text check (char_length(player_name) <= 40);
grant insert (player_name) on public.cc_games to anon, authenticated;

create index if not exists cc_games_visitor on public.cc_games (visitor_id, ts);

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

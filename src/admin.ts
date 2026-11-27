// Админка статистики: вход через Supabase Auth, чтение сводки и таблицы партий.
// Читать может только пользователь из таблицы cc_admins (проверяет сама база, см. supabase/schema.sql).
import './admin.css';
import { SUPABASE_KEY, SUPABASE_URL } from './telemetry';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TZ = 'Europe/Moscow';
const PAGE = 50;
const SESSION_KEY = 'chesscoach.admin.session';

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // мс
  user: { id: string; email: string };
}

let session: Session | null = load();

function load(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function store(s: Session | null): void {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* без хранилища вход живёт до перезагрузки */
  }
}

async function authToken(body: Record<string, string>, grant: 'password' | 'refresh_token'): Promise<Session> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(j.error_description ?? j.msg ?? j.message ?? res.statusText);
    throw new Error(/invalid login credentials/i.test(msg) ? 'Неверная почта или пароль' : msg);
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + Number(j.expires_in ?? 3600) * 1000,
    user: { id: j.user?.id, email: j.user?.email },
  };
}

async function token(): Promise<string> {
  if (!session) throw new Error('not_logged_in');
  if (session.expires_at - Date.now() < 60_000) {
    try {
      store(await authToken({ refresh_token: session.refresh_token }, 'refresh_token'));
    } catch {
      store(null);
      throw new Error('not_logged_in');
    }
  }
  return session!.access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    store(null);
    throw new Error('not_logged_in');
  }
  return res;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await api(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.message ?? res.statusText);
  return j as T;
}

// ---------- экран ----------

function showOnly(id: 'login' | 'not-admin' | 'dash'): void {
  for (const x of ['login', 'not-admin', 'dash']) $(x).classList.toggle('hidden', x !== id);
  const inside = id !== 'login';
  $('logout').classList.toggle('hidden', !inside);
  $('refresh').classList.toggle('hidden', id !== 'dash');
  $('who').textContent = inside && session ? session.user.email : '';
}

const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('ru-RU'));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | number | null, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text != null) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}

function fillTable(t: HTMLTableElement, head: string[], rows: (string | number | null | HTMLElement)[][], numeric: number[] = []): void {
  t.replaceChildren();
  const tr = el('tr');
  head.forEach((h, i) => tr.append(el('th', h, numeric.includes(i) ? 'n' : undefined)));
  t.append(el('thead'));
  t.tHead!.append(tr);
  const tb = el('tbody');
  if (!rows.length) {
    const r = el('tr');
    const td = el('td', 'Пока пусто', 'muted');
    td.colSpan = head.length;
    r.append(td);
    tb.append(r);
  }
  for (const row of rows) {
    const r = el('tr');
    row.forEach((c, i) => {
      const td = c instanceof HTMLElement ? c : el('td', c ?? '—', numeric.includes(i) ? 'n' : undefined);
      r.append(td);
    });
    tb.append(r);
  }
  t.append(tb);
}

interface Period { visitors: number; new_visitors: number; visits: number; games_started: number; games_finished: number; clips: number }
interface Summary {
  periods: Record<'today' | 'week' | 'month' | 'all', Period>;
  days: { day: string; visitors: number; started: number; finished: number }[];
  bots: { bot_id: string; bot_name: string | null; started: number; finished: number; player_wins: number; draws: number; bot_wins: number; avg_accuracy: number | null }[];
  modes: Record<string, number>;
  sources: { source: string; visits: number }[];
  devices: { device: string; visitors: number }[];
}

const BOT_EMOJI: Record<string, string> = { kid: '👶', grandpa: '👴', troll: '🤡', tiger: '🐯', taxi: '🧔', eagle: '🦅', prof: '🧠', machine: '🤖' };
const MODE_NAME: Record<string, string> = { bot: 'против бота', local: 'два игрока за компьютером', net: 'по сети' };

function renderSummary(s: Summary): void {
  const box = $('periods');
  box.replaceChildren();
  const names: [keyof Summary['periods'], string][] = [['today', 'Сегодня'], ['week', '7 дней'], ['month', '30 дней'], ['all', 'Всё время']];
  for (const [k, title] of names) {
    const p = s.periods[k];
    const card = el('div', null, 'card period');
    card.append(el('h3', title), el('div', fmt(p.visitors), 'big'));
    const kv = el('div', null, 'kv');
    const abandoned = Math.max(0, p.games_started - p.games_finished);
    const pairs: [string, string][] = [
      ['посетителей', fmt(p.visitors)],
      ['· новых', fmt(p.new_visitors)],
      ['· вернулись', fmt(p.visitors - p.new_visitors)],
      ['заходов', fmt(p.visits)],
      ['начато партий', fmt(p.games_started)],
      ['доиграно', `${fmt(p.games_finished)} (${pct(p.games_finished, p.games_started)})`],
      ['брошено', fmt(abandoned)],
      ['клипов', fmt(p.clips)],
    ];
    for (const [a, b] of pairs) kv.append(el('span', a), el('span', b));
    card.append(kv);
    box.append(card);
  }

  const days = $('days');
  days.replaceChildren();
  const max = Math.max(1, ...s.days.map((d) => Math.max(d.visitors, d.started, d.finished)));
  for (const d of s.days) {
    const col = el('div', null, 'day');
    const date = new Date(`${d.day}T12:00:00`);
    col.title = `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: посетителей ${d.visitors}, начато ${d.started}, доиграно ${d.finished}`;
    for (const [cls, v] of [['v', d.visitors], ['s', d.started], ['f', d.finished]] as const) {
      const bar = el('i', null, cls);
      bar.style.height = `${(v / max) * 100}%`;
      col.append(bar);
    }
    col.append(el('b', date.getDate()));
    days.append(col);
  }

  fillTable(
    $<HTMLTableElement>('bots'),
    ['Бот', 'Начато', 'Доиграно', 'Игрок выиграл', 'Ничьи', 'Бот выиграл', 'Бот побеждает', 'Ср. точность'],
    s.bots.map((b) => [
      `${BOT_EMOJI[b.bot_id] ?? ''} ${b.bot_name ?? b.bot_id}`,
      fmt(b.started), fmt(b.finished), fmt(b.player_wins), fmt(b.draws), fmt(b.bot_wins),
      pct(b.bot_wins, b.finished), b.avg_accuracy == null ? '—' : `${b.avg_accuracy}%`,
    ]),
    [1, 2, 3, 4, 5, 6, 7],
  );
  fillTable($<HTMLTableElement>('sources'), ['Источник', 'Заходов'], s.sources.map((x) => [x.source, fmt(x.visits)]), [1]);
  fillTable($<HTMLTableElement>('devices'), ['Устройство', 'Посетителей'], s.devices.map((x) => [x.device, fmt(x.visitors)]), [1]);
  fillTable($<HTMLTableElement>('modes'), ['Режим', 'Партий'], Object.entries(s.modes).map(([m, n]) => [MODE_NAME[m] ?? m, fmt(n)]), [1]);

  const botSel = $<HTMLSelectElement>('f-bot');
  const cur = botSel.value;
  botSel.replaceChildren(new Option('все боты', ''));
  for (const b of s.bots) botSel.add(new Option(`${BOT_EMOJI[b.bot_id] ?? ''} ${b.bot_name ?? b.bot_id}`, b.bot_id));
  botSel.value = cur;
}

// ---------- таблица партий ----------

interface GameRow {
  id: string; ts: string; visitor_id: string; mode: string; bot_id: string | null; bot_name: string | null;
  color: string | null; time_control: string | null; chess960: boolean; result: string; how: string | null;
  reason: string | null; opening: string | null; plies: number | null; accuracy: number | null;
  blunders: number | null; mistakes: number | null; inaccuracies: number | null; duration_s: number | null;
}

let page = 0;

const RESULT: Record<string, [string, string]> = {
  win: ['Игрок', 'win'], loss: ['Бот', 'loss'], draw: ['Ничья', 'draw'], white: ['Белые', 'win'], black: ['Чёрные', 'win'],
};
const HOW: Record<string, string> = { mate: 'мат', time: 'время', resign: 'сдача', draw: 'ничья', other: '—' };

function dur(s: number | null): string {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : m ? `${m} мин ${s % 60} с` : `${s} с`;
}

async function loadGames(): Promise<void> {
  const q = new URLSearchParams({ select: '*', order: 'ts.desc', limit: String(PAGE), offset: String(page * PAGE) });
  const mode = $<HTMLSelectElement>('f-mode').value;
  const bot = $<HTMLSelectElement>('f-bot').value;
  const player = $<HTMLInputElement>('f-player').value.trim().toLowerCase();
  if (mode) q.append('mode', `eq.${mode}`);
  if (bot) q.append('bot_id', `eq.${bot}`);
  if (/^[0-9a-f-]{36}$/.test(player)) q.append('visitor_id', `eq.${player}`);
  else if (/^[0-9a-f]{1,8}$/.test(player)) {
    // uuid нельзя искать по началу напрямую — ищем в диапазоне номеров с этим началом
    const lo = player.padEnd(8, '0'), hi = player.padEnd(8, 'f');
    q.append('visitor_id', `gte.${lo}-0000-0000-0000-000000000000`);
    q.append('visitor_id', `lte.${hi}-ffff-ffff-ffff-ffffffffffff`);
  }
  const res = await api(`cc_games?${q}`, { headers: { Prefer: 'count=exact' } });
  const rows = (await res.json().catch(() => [])) as GameRow[];
  if (!res.ok) throw new Error((rows as unknown as { message?: string }).message ?? res.statusText);
  const total = Number(res.headers.get('content-range')?.split('/')[1] ?? rows.length);
  $('games-count').textContent = `всего ${fmt(total)}`;
  $('page').textContent = total ? `${page * PAGE + 1}–${page * PAGE + rows.length}` : '';
  $<HTMLButtonElement>('prev').disabled = page === 0;
  $<HTMLButtonElement>('next').disabled = (page + 1) * PAGE >= total;

  fillTable(
    $<HTMLTableElement>('games'),
    ['Дата', 'Игрок', 'Соперник', 'Цвет', 'Победил', 'Чем кончилось', 'Ходов', 'Точность', 'Зевки', 'Ошибки', 'Часы', 'Длилась', 'Дебют'],
    rows.map((g) => {
      const pl = el('td', g.visitor_id.slice(0, 6), 'pl');
      pl.title = `${g.visitor_id}\nнажмите — показать только его партии`;
      pl.onclick = () => {
        $<HTMLInputElement>('f-player').value = g.visitor_id;
        page = 0;
        void loadGames().catch(fail);
      };
      const [rt, rc] = RESULT[g.result] ?? [g.result, ''];
      const res = el('td', rt, rc);
      res.title = g.reason ?? '';
      const opp = g.mode === 'bot' ? `${BOT_EMOJI[g.bot_id ?? ''] ?? ''} ${g.bot_name ?? g.bot_id}` : MODE_NAME[g.mode] ?? g.mode;
      return [
        new Date(g.ts).toLocaleString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        pl,
        opp + (g.chess960 ? ' · 960' : ''),
        g.color === 'white' ? '⚪' : g.color === 'black' ? '⚫' : '—',
        res,
        HOW[g.how ?? 'other'] ?? g.how,
        g.plies == null ? '—' : Math.ceil(g.plies / 2),
        g.accuracy == null ? '—' : `${g.accuracy}%`,
        g.mode === 'bot' ? g.blunders : '—',
        g.mode === 'bot' ? g.mistakes : '—',
        g.time_control,
        dur(g.duration_s),
        g.opening,
      ];
    }),
    [6, 7, 8, 9],
  );
}

// ---------- запуск ----------

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === 'not_logged_in') {
    showOnly('login');
    return;
  }
  alert(`Ошибка: ${msg}`);
}

async function enter(): Promise<void> {
  if (!session) return showOnly('login');
  const admin = await rpc<boolean>('cc_is_admin');
  if (!admin) {
    showOnly('not-admin');
    const box = $('not-admin');
    box.replaceChildren(
      el('h2', 'Вход выполнен, но этот пользователь пока не админ'),
      el('p', 'Откройте Supabase → SQL Editor, вставьте строку ниже и нажмите Run. Потом обновите эту страницу.'),
      el('code', `insert into public.cc_admins (user_id) values ('${session.user.id}');`),
    );
    return;
  }
  showOnly('dash');
  await refresh();
}

async function refresh(): Promise<void> {
  const btn = $<HTMLButtonElement>('refresh');
  btn.disabled = true;
  try {
    renderSummary(await rpc<Summary>('cc_summary', { tz: TZ }));
    await loadGames();
  } finally {
    btn.disabled = false;
  }
}

$('login').onsubmit = async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  try {
    store(await authToken({ email: $<HTMLInputElement>('email').value.trim(), password: $<HTMLInputElement>('password').value }, 'password'));
    $<HTMLInputElement>('password').value = '';
    await enter();
  } catch (err) {
    $('login-err').textContent = err instanceof Error ? err.message : String(err);
  }
};
$('logout').onclick = () => {
  const t = session?.access_token;
  store(null);
  if (t) void fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${t}` } }).catch(() => undefined);
  showOnly('login');
};
$('refresh').onclick = () => void refresh().catch(fail);
$('prev').onclick = () => {
  page = Math.max(0, page - 1);
  void loadGames().catch(fail);
};
$('next').onclick = () => {
  page++;
  void loadGames().catch(fail);
};
for (const id of ['f-mode', 'f-bot']) $(id).onchange = () => ((page = 0), void loadGames().catch(fail));
$('f-player').onchange = () => ((page = 0), void loadGames().catch(fail));

void enter().catch(fail);

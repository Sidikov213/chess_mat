// Админка статистики: вход через Supabase Auth, чтение сводки и таблицы партий.
// Читать может только пользователь из таблицы cc_admins (проверяет сама база, см. supabase/schema.sql).
import './admin.css';
import { SUPABASE_KEY, SUPABASE_URL } from './telemetry';
import { openWatch, type LiveInfo } from './watch';

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
const pctN = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function plural(n: number, [one, few, many]: [string, string, string]): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | number | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

/** Небольшой HTML из доверенного шаблона; данные подставлять только через esc(). */
function html(cls: string, markup: string, tag: keyof HTMLElementTagNameMap = 'div'): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = markup;
  return e;
}
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Period { visitors: number; new_visitors: number; visits: number; games_started: number; games_finished: number; clips: number }
type PeriodKey = 'today' | 'week' | 'month' | 'all';
interface Day { day: string; visitors: number; started: number; finished: number }
interface Summary {
  periods: Record<PeriodKey, Period>;
  days: Day[];
  bots: { bot_id: string; bot_name: string | null; started: number; finished: number; player_wins: number; draws: number; bot_wins: number; avg_accuracy: number | null }[];
  modes: Record<string, number>;
  sources: { source: string; visits: number }[];
  devices: { device: string; visitors: number }[];
  players?: { visitor_id: string; name: string | null; first_ts: string; last_ts: string; games: number; wins: number; bot_games: number }[];
}

const BOT_EMOJI: Record<string, string> = { kid: '👶', grandpa: '👴', troll: '🤡', tiger: '🐯', taxi: '🧔', eagle: '🦅', prof: '🧠', machine: '🤖' };
const BOT_ORDER = ['kid', 'grandpa', 'troll', 'tiger', 'taxi', 'eagle', 'prof', 'machine'];
const MODE_NAME: Record<string, string> = { bot: 'Против бота', local: 'Два игрока за одним экраном', net: 'По сети' };
const SOURCE_NAME: Record<string, string> = { tiktok: 'TikTok', telegram: 'Telegram', vk: 'ВКонтакте', youtube: 'YouTube', instagram: 'Instagram', google: 'Google', yandex: 'Яндекс' };

let summary: Summary | null = null;
let period: PeriodKey = (pref('period') as PeriodKey) || 'today';
let metric: keyof Omit<Day, 'day'> = (pref('metric') as keyof Omit<Day, 'day'>) || 'visitors';
let selDay = -1;

function pref(k: string, v?: string): string | null {
  try {
    if (v !== undefined) localStorage.setItem(`chesscoach.admin.${k}`, v);
    return localStorage.getItem(`chesscoach.admin.${k}`);
  } catch {
    return null;
  }
}

function markSeg(id: string, attr: string, value: string): void {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset[attr] === value);
}

function renderKpis(): void {
  if (!summary) return;
  markSeg('period', 'p', period);
  const p = summary.periods[period];
  const returning = Math.max(0, p.visitors - p.new_visitors);
  const abandoned = Math.max(0, p.games_started - p.games_finished);
  const done = pctN(p.games_finished, p.games_started);
  const box = $('kpis');
  box.replaceChildren(
    html('kpi', `<div class="label">Посетители</div><div class="value">${fmt(p.visitors)}</div>
      <div class="sub"><b>${fmt(p.new_visitors)}</b> ${plural(p.new_visitors, ['новый', 'новых', 'новых'])} · <b>${fmt(returning)}</b> ${plural(returning, ['вернулся', 'вернулись', 'вернулись'])}</div>`),
    html('kpi', `<div class="label">Партии</div><div class="value">${fmt(p.games_started)}</div>
      <div class="meter" title="доиграно ${done}%"><i class="a" style="flex:${p.games_finished}"></i><i class="b" style="flex:${p.games_started ? abandoned : 1}"></i></div>
      <div class="sub"><b>${fmt(p.games_finished)}</b> доиграно${p.games_started ? ` (${done}%)` : ''} · <b>${fmt(abandoned)}</b> брошено</div>`),
    html('kpi', `<div class="label">Заходы на сайт</div><div class="value">${fmt(p.visits)}</div>
      <div class="sub">${p.visitors ? `<b>${(p.visits / p.visitors).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</b> на человека` : 'пока никого'}</div>`),
    html('kpi', `<div class="label">Клипы</div><div class="value">${fmt(p.clips)}</div>
      <div class="sub">${p.games_finished ? `<b>${pctN(p.clips, p.games_finished)}%</b> от доигранных` : 'для TikTok и Reels'}</div>`),
  );
}

const METRIC_TEXT: Record<string, [string, [string, string, string]]> = {
  visitors: ['Посетители по дням', ['посетитель', 'посетителя', 'посетителей']],
  started: ['Начатые партии по дням', ['партия', 'партии', 'партий']],
  finished: ['Доигранные партии по дням', ['партия', 'партии', 'партий']],
};

function renderChart(): void {
  if (!summary) return;
  markSeg('metric', 'm', metric);
  const days = summary.days;
  const [title, forms] = METRIC_TEXT[metric];
  $('chart-title').textContent = title;
  const box = $('chart');
  const W = Math.max(280, box.clientWidth || 320), H = box.clientHeight || 170;
  const padL = 26, padB = 20, padT = 6;
  const vals = days.map((d) => d[metric]);
  const rawMax = Math.max(...vals, 0);
  const step = rawMax <= 4 ? 1 : rawMax <= 10 ? 2 : Math.pow(10, Math.floor(Math.log10(rawMax))) * (rawMax / Math.pow(10, Math.floor(Math.log10(rawMax))) > 5 ? 2 : 1);
  const max = Math.max(step * 2, Math.ceil(rawMax / step) * step);
  const plotW = W - padL, plotH = H - padB - padT;
  const slot = plotW / days.length;
  const bw = Math.max(3, Math.min(18, slot - 3));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    svg.append(n);
    return n;
  };
  for (const v of [0, max / 2, max]) {
    add('line', { class: 'grid', x1: padL, x2: W, y1: y(v), y2: y(v) });
    add('text', { class: 'ax', x: 0, y: y(v) + 4 }, fmt(v));
  }
  if (selDay < 0 || selDay >= days.length) selDay = days.length - 1;
  days.forEach((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const v = d[metric];
    if (v > 0) {
      const h = Math.max(2, (v / max) * plotH);
      // округлён только верх, низ стоит на оси
      const r = Math.min(4, bw / 2, h);
      const top = y(v), bot = padT + plotH;
      add('path', {
        class: '', fill: i === selDay ? '#6aabf1' : 'var(--s1)',
        d: `M${x},${bot}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${bot}Z`,
      });
    }
    const date = new Date(`${d.day}T12:00:00`);
    if (i % 7 === (days.length - 1) % 7)
      add('text', { class: 'ax', x: padL + i * slot + slot / 2, y: H - 4, 'text-anchor': 'middle' },
        date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', ''));
    const hit = add('rect', { class: 'hit', x: padL + i * slot, y: 0, width: slot, height: H - padB });
    const pick = () => {
      selDay = i;
      renderChart();
    };
    hit.addEventListener('click', pick);
    hit.addEventListener('mouseenter', pick);
  });
  box.replaceChildren(svg);
  const d = days[selDay];
  if (d) {
    const v = d[metric];
    const date = new Date(`${d.day}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
    $('chart-tip').innerHTML = `${esc(date)}: <b>${fmt(v)}</b> ${plural(v, forms)}`;
  }
}

function hbars(id: string, rows: [string, number][], unit: [string, string, string]): void {
  const box = $(id);
  box.replaceChildren();
  if (!rows.length) return void box.append(el('div', 'empty', 'Пока нет данных'));
  const max = Math.max(...rows.map((r) => r[1]), 1);
  const total = rows.reduce((a, r) => a + r[1], 0);
  for (const [name, v] of rows)
    box.append(html('hbar', `<span class="t">${esc(name)}</span><span class="v"><b>${fmt(v)}</b> · ${pctN(v, total)}%</span>
      <span class="track"><i style="width:${(v / max) * 100}%"></i></span>`));
  box.title = unit[2];
}

const AV_COLORS = ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'];
function avColor(id: string): string {
  return AV_COLORS[parseInt(id.slice(0, 2), 16) % AV_COLORS.length];
}

function ago(ts: string): string {
  const min = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (min < 2) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short' }).replace('.', '');
}

let playersAll = false;

function renderPlayers(): void {
  const list = summary?.players;
  $('players-card').classList.toggle('hidden', !list);
  if (!list) return;
  const box = $('players');
  box.replaceChildren();
  const named = list.filter((p) => p.name).length;
  $('players-count').textContent = list.length ? `${named} с именем из ${list.length}` : '';
  if (!list.length) box.append(el('div', 'empty', 'Пока никого'));
  const shown = playersAll ? list : list.slice(0, 8);
  for (const p of shown) {
    const name = p.name ?? '';
    const btn = html('player', `
      <span class="ini" style="background:${avColor(p.visitor_id)}">${name ? esc([...name][0].toUpperCase()) : '?'}</span>
      <span class="pn${name ? '' : ' anon'}">${name ? esc(name) : `без имени · ${esc(p.visitor_id.slice(0, 6))}`}</span>
      <span class="when">${esc(ago(p.last_ts))}</span>
      <span class="ps">${p.games ? `<b>${fmt(p.games)}</b> ${plural(p.games, ['партия', 'партии', 'партий'])} · <b>${fmt(p.wins)}</b> ${plural(p.wins, ['победа', 'победы', 'побед'])}` : 'ещё не доиграл ни одной партии'}</span>`, 'button');
    btn.title = p.visitor_id;
    btn.onclick = () => {
      setPlayer(p.visitor_id);
      $('games').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    box.append(btn);
  }
  const more = $('players-more');
  more.classList.toggle('hidden', list.length <= 8);
  more.textContent = playersAll ? 'Свернуть' : `Показать всех (${list.length})`;
}

function renderSummary(): void {
  if (!summary) return;
  const s = summary;
  renderKpis();
  renderChart();
  renderPlayers();

  const bots = $('bots');
  bots.replaceChildren();
  const list = [...s.bots].sort((a, b) => BOT_ORDER.indexOf(a.bot_id) - BOT_ORDER.indexOf(b.bot_id));
  if (!list.length) bots.append(el('div', 'empty', 'С ботами ещё никто не играл'));
  for (const b of list) {
    const f = b.finished;
    const meta = f
      ? `бот побеждает в ${pctN(b.bot_wins, f)}%` + (b.avg_accuracy != null ? ` · средняя точность игрока ${b.avg_accuracy}%` : '')
      : 'ещё никто не доиграл';
    bots.append(html('bot', `
      <div class="av">${BOT_EMOJI[b.bot_id] ?? '♟️'}</div>
      <div class="name">${esc(b.bot_name ?? b.bot_id)}</div>
      <div class="num"><b>${fmt(b.started)}</b> ${plural(b.started, ['партия', 'партии', 'партий'])}${b.started !== f ? ` · ${fmt(f)} доиграно` : ''}</div>
      <div class="stack" title="игрок ${b.player_wins} · ничьи ${b.draws} · бот ${b.bot_wins}">
        ${b.player_wins ? `<i class="w" style="flex:${b.player_wins}"></i>` : ''}${b.draws ? `<i class="d" style="flex:${b.draws}"></i>` : ''}${b.bot_wins ? `<i class="l" style="flex:${b.bot_wins}"></i>` : ''}
      </div>
      <div class="meta">${f ? `${b.player_wins} : ${b.draws} : ${b.bot_wins} · ` : ''}${esc(meta)}</div>`));
  }

  hbars('sources', s.sources.map((x) => [SOURCE_NAME[x.source] ?? x.source, x.visits]), ['заход', 'захода', 'заходов']);
  hbars('devices', s.devices.map((x) => [x.device === 'телефон' ? '📱 Телефон' : x.device === 'компьютер' ? '💻 Компьютер' : x.device, x.visitors]), ['человек', 'человека', 'человек']);
  hbars('modes', Object.entries(s.modes).map(([m, n]) => [MODE_NAME[m] ?? m, n] as [string, number]).sort((a, b) => b[1] - a[1]), ['партия', 'партии', 'партий']);

  const botSel = $<HTMLSelectElement>('f-bot');
  const cur = botSel.value;
  botSel.replaceChildren(new Option('Все боты', ''));
  for (const b of list) botSel.add(new Option(`${BOT_EMOJI[b.bot_id] ?? ''} ${b.bot_name ?? b.bot_id}`, b.bot_id));
  botSel.value = cur;
}

// ---------- партии ----------

interface GameRow {
  id: string; ts: string; visitor_id: string; mode: string; bot_id: string | null; bot_name: string | null;
  color: string | null; time_control: string | null; chess960: boolean; result: string; how: string | null;
  reason: string | null; opening: string | null; plies: number | null; accuracy: number | null;
  blunders: number | null; mistakes: number | null; inaccuracies: number | null; duration_s: number | null;
  player_name?: string | null;
}

let page = 0;

const HOW: Record<string, string> = { mate: 'мат', time: 'по времени', resign: 'сдача', draw: 'ничья', other: '' };

function dur(s: number | null): string {
  if (s == null) return '';
  const m = Math.round(s / 60);
  return s < 60 ? `${s} с` : m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}

function setPlayer(v: string): void {
  $<HTMLInputElement>('f-player').value = v;
  $('f-player-clear').classList.toggle('hidden', !v);
  page = 0;
  void loadGames().catch(fail);
}

async function loadGames(): Promise<void> {
  const q = new URLSearchParams({ select: '*', order: 'ts.desc', limit: String(PAGE), offset: String(page * PAGE) });
  const mode = $<HTMLSelectElement>('f-mode').value;
  const bot = $<HTMLSelectElement>('f-bot').value;
  const player = $<HTMLInputElement>('f-player').value.trim().toLowerCase();
  $('f-player-clear').classList.toggle('hidden', !player);
  if (mode) q.append('mode', `eq.${mode}`);
  if (bot) q.append('bot_id', `eq.${bot}`);
  const rawPlayer = $<HTMLInputElement>('f-player').value.trim();
  const nameQ = rawPlayer.replace(/[*,()%\\"]/g, '');
  if (/^[0-9a-f-]{36}$/.test(player)) q.append('visitor_id', `eq.${player}`);
  else if (/^[0-9a-f]{1,8}$/.test(player)) {
    // похоже на начало номера — ищем и по номеру (диапазон uuid с этим началом), и по имени
    const lo = player.padEnd(8, '0'), hi = player.padEnd(8, 'f');
    q.append('or', `(player_name.ilike.*${nameQ}*,and(visitor_id.gte.${lo}-0000-0000-0000-000000000000,visitor_id.lte.${hi}-ffff-ffff-ffff-ffffffffffff))`);
  } else if (nameQ) q.append('player_name', `ilike.*${nameQ}*`);
  const res = await api(`cc_games?${q}`, { headers: { Prefer: 'count=exact' } });
  const rows = (await res.json().catch(() => [])) as GameRow[];
  if (!res.ok) throw new Error((rows as unknown as { message?: string }).message ?? res.statusText);
  const total = Number(res.headers.get('content-range')?.split('/')[1] ?? rows.length);
  $('games-count').textContent = `${fmt(total)} ${plural(total, ['партия', 'партии', 'партий'])}`;
  $('page').textContent = total > PAGE ? `${page * PAGE + 1}–${page * PAGE + rows.length} из ${fmt(total)}` : '';
  $<HTMLButtonElement>('prev').disabled = page === 0;
  $<HTMLButtonElement>('next').disabled = (page + 1) * PAGE >= total;
  $('prev').parentElement!.classList.toggle('hidden', total <= PAGE);

  const box = $('games');
  box.replaceChildren();
  if (!rows.length) box.append(el('div', 'empty', player || mode || bot ? 'Ничего не нашлось' : 'Пока ни одной доигранной партии'));
  for (const g of rows) {
    const isBot = g.mode === 'bot';
    const [badge, cls] =
      g.result === 'win' ? ['Победа игрока', 'win']
      : g.result === 'loss' ? ['Победа бота', 'loss']
      : g.result === 'draw' ? ['Ничья', 'draw']
      : [g.result === 'white' ? 'Белые победили' : 'Чёрные победили', 'win'];
    const moves = g.plies == null ? null : Math.ceil(g.plies / 2);
    const parts = [
      HOW[g.how ?? 'other'],
      moves == null ? '' : `${moves} ${plural(moves, ['ход', 'хода', 'ходов'])}`,
      g.accuracy == null ? '' : `точность <b>${g.accuracy}%</b>`,
      isBot && g.blunders ? `${g.blunders} ${plural(g.blunders, ['зевок', 'зевка', 'зевков'])}` : '',
    ].filter(Boolean);
    const when = new Date(g.ts).toLocaleString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
    const card = html('game', `
      <div class="av">${isBot ? BOT_EMOJI[g.bot_id ?? ''] ?? '♟️' : '👥'}</div>
      <div class="opp">${isBot ? esc(g.bot_name ?? g.bot_id) : 'Два игрока'}${g.chess960 ? ' <small>· 960</small>' : ''}${isBot && g.color ? ` <small>· ${g.color === 'white' ? 'за белых' : 'за чёрных'}</small>` : ''}</div>
      <span class="badge ${cls}" title="${esc(g.reason)}">${badge}</span>
      <div class="line">${parts.map((x) => `<span>${x}</span>`).join(' · ')}</div>
      <div class="line"><button class="chip${g.player_name ? ' named' : ''}" title="${esc(g.visitor_id)}">${g.player_name ? `👤 ${esc(g.player_name)}` : esc(g.visitor_id.slice(0, 6))}</button> · <span>${esc(when)}</span>${g.duration_s != null ? ` · <span>${dur(g.duration_s)}</span>` : ''}${g.time_control && g.time_control !== 'Без часов' ? ` · <span>⏱ ${esc(g.time_control.replace(/\s*\(.*\)/, '').replace(/ \+ /, '+'))}</span>` : ''}</div>`);
    card.querySelector<HTMLButtonElement>('.chip')!.onclick = () => setPlayer(g.visitor_id);
    if (g.opening) card.title = g.opening;
    box.append(card);
  }
}

// ---------- сейчас играют ----------

interface LiveRow extends LiveInfo { ts: string; ply: number }
const LIVE_EVERY_MS = 10_000;
let liveTimer = 0;
let watching = false;

async function loadLive(): Promise<void> {
  clearTimeout(liveTimer);
  let list: LiveRow[] | null = null;
  try {
    list = await rpc<LiveRow[]>('cc_live', { minutes: 15 });
  } catch (e) {
    if (e instanceof Error && e.message === 'not_logged_in') throw e;
    list = null; // в базе ещё нет добавки 003_live.sql — блок просто не показываем
  }
  const card = $('live-card');
  card.classList.toggle('hidden', !list);
  if (list) {
    const box = $('live');
    box.replaceChildren();
    $('live-count').textContent = list.length ? `${list.length}` : '';
    if (!list.length) box.append(el('div', 'empty', 'Сейчас никто не играет. Блок обновляется сам.'));
    for (const g of list) {
      const name = g.name ?? '';
      const i = g.info ?? {};
      const vs = i.mode === 'bot' ? `против ${BOT_EMOJI[i.bot_id ?? ''] ?? ''} ${i.bot_name ?? 'бота'}` : 'два игрока';
      const moves = Math.ceil(g.ply / 2);
      const row = html('live-row', `
        <span class="ini" style="background:${avColor(g.visitor_id)}">${name ? esc([...name][0].toUpperCase()) : '?'}</span>
        <span class="pn">${name ? esc(name) : `без имени · ${esc(g.visitor_id.slice(0, 6))}`}</span>
        <span class="watch-btn">👁 Смотреть</span>
        <span class="ls">${esc(vs)} · ${moves} ${plural(moves, ['ход', 'хода', 'ходов'])} · ${esc(ago(g.ts))}</span>`, 'button');
      row.onclick = () => {
        watching = true;
        const close = openWatch(g, api);
        const obs = new MutationObserver(() => {
          if (!document.querySelector('.watch')) {
            obs.disconnect();
            watching = false;
            void loadLive().catch(fail);
          }
        });
        obs.observe(document.body, { childList: true });
        void close;
      };
      box.append(row);
    }
  }
  liveTimer = window.setTimeout(() => {
    if (!watching && !document.hidden && session) void loadLive().catch(fail);
    else liveTimer = window.setTimeout(() => void loadLive().catch(fail), LIVE_EVERY_MS);
  }, LIVE_EVERY_MS);
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
      el('h2', undefined, 'Вход выполнен, но этот пользователь пока не админ'),
      el('p', undefined, 'Откройте Supabase → SQL Editor, вставьте строку ниже и нажмите Run. Потом обновите эту страницу.'),
      el('code', undefined, `insert into public.cc_admins (user_id) values ('${session.user.id}');`),
    );
    return;
  }
  showOnly('dash');
  await refresh();
}

async function refresh(): Promise<void> {
  const btn = $<HTMLButtonElement>('refresh');
  btn.disabled = true;
  btn.classList.add('spin');
  try {
    summary = await rpc<Summary>('cc_summary', { tz: TZ });
    selDay = -1;
    renderSummary();
    await Promise.all([loadGames(), loadLive()]);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spin');
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
$('f-player').onchange = () => setPlayer($<HTMLInputElement>('f-player').value.trim());
$('f-player-clear').onclick = () => setPlayer('');
for (const b of $('period').querySelectorAll<HTMLButtonElement>('button'))
  b.onclick = () => {
    period = b.dataset.p as PeriodKey;
    pref('period', period);
    renderKpis();
  };
for (const b of $('metric').querySelectorAll<HTMLButtonElement>('button'))
  b.onclick = () => {
    metric = b.dataset.m as typeof metric;
    pref('metric', metric);
    renderChart();
  };
$('players-more').onclick = () => {
  playersAll = !playersAll;
  renderPlayers();
};
let resizeT = 0;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = window.setTimeout(renderChart, 150);
});

void enter().catch(fail);

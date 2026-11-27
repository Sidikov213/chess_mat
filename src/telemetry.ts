// Анонимная статистика сайта в Supabase: заходы, начатые и законченные партии, клипы.
// Только сайт (http/https). В приложении для компьютера и при разработке ничего не отправляется.
// Игрок различается по случайному номеру в localStorage браузера; имён и почты нет.
// Отправка «выстрелил и забыл»: ошибки сети молча игнорируются, игре они не мешают.

/** Адрес проекта и публичный ключ (publishable). Ключ можно хранить в коде: он даёт только запись. */
export const SUPABASE_URL: string =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://iktcpzmheorjtbovoooz.supabase.co';
export const SUPABASE_KEY: string =
  (import.meta.env.VITE_SUPABASE_KEY as string | undefined) ?? 'sb_publishable_Qm9tAus77Bq5GNkDRAZ_KA_gOEG1Gud';

const ENABLED =
  !!SUPABASE_URL &&
  !!SUPABASE_KEY &&
  location.protocol.startsWith('http') &&
  (import.meta.env.PROD || import.meta.env.VITE_TELEMETRY_DEV === '1') &&
  !['localhost', '127.0.0.1'].includes(location.hostname) &&
  !safeGet('chesscoach.notrack'); // свой браузер можно исключить: localStorage chesscoach.notrack = 1

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function visitorId(): string {
  const KEY = 'chesscoach.vid';
  let id = safeGet(KEY);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    id = uuid();
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* без хранилища номер живёт до закрытия вкладки */
    }
  }
  return id;
}

const VISITOR = ENABLED ? visitorId() : '';
const SESSION = ENABLED ? uuid() : '';

function send(table: string, row: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
    keepalive: true,
  });
}

/** Отправка «выстрелил и забыл». optional — поля, без которых строку можно повторить, если база их не знает. */
function post(table: string, row: Record<string, unknown>, optional: string[] = []): void {
  if (!ENABLED) return;
  void send(table, row)
    .then((res) => {
      if (res.ok || res.status >= 500 || !optional.some((k) => k in row)) return;
      const rest = { ...row };
      for (const k of optional) delete rest[k];
      return send(table, rest);
    })
    .catch(() => undefined);
}

function event(kind: 'visit' | 'game_start' | 'clip' | 'name', data: Record<string, unknown>, gameId?: string): void {
  const name = playerName();
  post('cc_events', { visitor_id: VISITOR, session_id: SESSION, kind, game_id: gameId ?? null, data: name ? { name, ...data } : data });
}

// ---------- имя игрока ----------

const NAME_KEY = 'chesscoach.name';
export const NAME_MAX = 24;

/** Сайт со статистикой (а не приложение и не разработка) — только тогда спрашиваем имя. */
export const telemetryEnabled = (): boolean => ENABLED;

export function playerName(): string {
  return safeGet(NAME_KEY) ?? '';
}

/** Чистит ввод: без управляющих символов и лишних пробелов, не длиннее NAME_MAX. */
export function cleanName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

export function setPlayerName(raw: string): string {
  const name = cleanName(raw);
  if (!name || name === playerName()) return name;
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* не сохранилось — спросим в следующий раз */
  }
  event('name', {});
  return name;
}

/** Откуда пришёл: utm_source из ссылки, иначе сайт-источник. */
function source(): string {
  const utm = new URLSearchParams(location.search).get('utm_source');
  if (utm) return utm.slice(0, 40).toLowerCase();
  try {
    const host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : '';
    if (!host || host === location.hostname) return '';
    if (/tiktok/.test(host)) return 'tiktok';
    if (/(^|\.)t\.me$|telegram/.test(host)) return 'telegram';
    if (/vk\.(com|ru)|vk\.link/.test(host)) return 'vk';
    if (/youtube|youtu\.be/.test(host)) return 'youtube';
    if (/instagram/.test(host)) return 'instagram';
    if (/google\./.test(host)) return 'google';
    if (/yandex\.|ya\.ru/.test(host)) return 'yandex';
    return host.slice(0, 60);
  } catch {
    return '';
  }
}

/** Один раз при открытии страницы. */
export function trackVisit(): void {
  const mobile = matchMedia('(pointer: coarse)').matches || /Mobi|Android|iPhone/i.test(navigator.userAgent);
  event('visit', {
    source: source(),
    device: mobile ? 'телефон' : 'компьютер',
    lang: navigator.language.slice(0, 10),
    pwa: matchMedia('(display-mode: standalone)').matches,
  });
}

export interface GameInfo {
  mode: 'bot' | 'local' | 'net';
  bot_id?: string;
  bot_name?: string;
  bot_elo?: number;
  color?: 'white' | 'black';
  time_control?: string;
  chess960: boolean;
}

export interface GameResult {
  result: 'win' | 'loss' | 'draw' | 'white' | 'black';
  how: 'mate' | 'time' | 'resign' | 'draw' | 'other';
  reason: string;
  opening: string | null;
  plies: number;
  accuracy?: number | null;
  blunders?: number;
  mistakes?: number;
  inaccuracies?: number;
}

/** Партия, которую отслеживаем: start() — при первом ходе, finish() — один раз в конце. */
export class TrackedGame {
  readonly id = uuid();
  private startedAt = 0;
  private finished = false;

  constructor(private info: GameInfo) {}

  get started(): boolean {
    return this.startedAt > 0;
  }

  start(): void {
    if (this.startedAt) return;
    this.startedAt = Date.now();
    event('game_start', { ...this.info }, this.id);
  }

  finish(r: GameResult): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.startedAt) this.start();
    post('cc_games', {
      id: this.id,
      visitor_id: VISITOR,
      player_name: playerName() || null,
      ...this.info,
      ...r,
      reason: r.reason.slice(0, 120),
      opening: r.opening?.slice(0, 120) ?? null,
      accuracy: r.accuracy == null ? null : Math.round(r.accuracy),
      duration_s: Math.round((Date.now() - this.startedAt) / 1000),
    }, ['player_name']);
  }
}

export function trackClip(data: Record<string, unknown>): void {
  event('clip', data);
}

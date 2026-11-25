// Клип для соцсетей: короткое вертикальное видео (720×1280) последнего момента партии —
// несколько ходов до него, сам ход с пометкой, реплика тренера крупно и его голос.
// Доску рисуем сами на canvas, звук собираем в Web Audio, пишем MediaRecorder'ом в реальном времени.
import type { Chess } from 'chessops/chess';
import { parseUci } from 'chessops/util';
import { posFromFen, type Side } from './shared';
import { scheduleSound, type SoundKind } from './sounds';
import type { ChatLine } from './chat';
import { fmtAura } from './fx';

export interface ClipMoment {
  startFen: string;
  /** Все ходы партии по момент включительно. */
  ucis: string[];
  orientation: Side;
  /** Реплика тренера; null — тренер «без цензуры» выключен, показываем только оценку. */
  phrase: string | null;
  /** Строка над репликой: «Фd5?? — зевок», «Мат. Победа!». */
  verdict: string;
  /** Цвет момента: blunder | mistake | inaccuracy | good | best. */
  cls: string;
  /** Пометка на клетке хода: «??», «?», «!» и т. п. */
  mark: string;
  /** «Я vs 🐯 Тигр Расул». */
  title: string;
  /** Насколько момент яркий — для выбора лучшего клипа партии. */
  drama: number;
  /** Изменение ауры на этом ходе. */
  aura?: number;
  /** Что написал чат «стрима» в этот момент. */
  chat?: ChatLine[];
  /** Мат игроку — «ПОТРАЧЕНО». */
  wasted?: boolean;
}

/** Адрес сайта для подписи в углу клипа; задаётся при сборке (VITE_SITE_URL). */
export const SITE_URL: string = (import.meta.env.VITE_SITE_URL as string | undefined) ?? '';

const W = 720;
const H = 1280;
const BOARD = 680;
const BX = (W - BOARD) / 2;
const BY = 190;
const SQ = BOARD / 8;
const FPS = 30;

const COLORS: Record<string, string> = {
  blunder: '#e5534b',
  mistake: '#e0a030',
  inaccuracy: '#d8c860',
  good: '#8fc46f',
  best: '#6aa84f',
};

type Cell = string | null; // «wq», «bk» …

function cells(pos: Chess): Cell[] {
  const out: Cell[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = pos.board.get(sq);
    out.push(p ? `${p.color[0]}${p.role}` : null);
  }
  return out;
}

/** Картинки фигур берём из той же темы chessground, что и на доске. */
let pieceImgs: Promise<Map<string, HTMLImageElement>> | null = null;
function loadPieces(): Promise<Map<string, HTMLImageElement>> {
  pieceImgs ??= (async () => {
    const box = document.createElement('div');
    box.className = 'cg-wrap';
    box.style.cssText = 'position:absolute;left:-9999px;width:80px;height:80px';
    document.body.append(box);
    const map = new Map<string, HTMLImageElement>();
    const roles = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
    await Promise.all(
      ['white', 'black'].flatMap((color) =>
        roles.map(async (role) => {
          const el = document.createElement('piece');
          el.className = `${role} ${color}`;
          box.append(el);
          const m = /url\("?(.+?)"?\)$/.exec(getComputedStyle(el).backgroundImage);
          if (!m) return;
          const img = new Image();
          img.src = m[1];
          await img.decode().catch(() => undefined);
          map.set(`${color[0]}${role}`, img);
        }),
      ),
    );
    box.remove();
    return map;
  })();
  return pieceImgs;
}

interface Step {
  before: Cell[];
  after: Cell[];
  /** Какие фигуры куда едут: [откуда, куда, фигура]. */
  slides: [number, number, string][];
  from: number;
  to: number;
  sound: SoundKind;
}

/** Ход как разница двух позиций — так же, как анимирует chessground (рокировка, взятие на проходе). */
function makeStep(pos: Chess, uci: string): Step {
  const before = cells(pos);
  const move = parseUci(uci)!;
  const capture = 'from' in move && (!!pos.board.get(move.to) && pos.board.get(move.to)!.color !== pos.turn);
  pos.play(move);
  const after = cells(pos);
  const gone = before.map((c, i) => (c && c !== after[i] ? i : -1)).filter((i) => i >= 0);
  const came = after.map((c, i) => (c && c !== before[i] ? i : -1)).filter((i) => i >= 0);
  const used = new Set<number>();
  const slides: [number, number, string][] = [];
  for (const to of came) {
    const piece = after[to]!;
    let best = -1;
    let bestD = 99;
    for (const from of gone) {
      if (used.has(from) || before[from] !== piece) continue;
      const d = Math.hypot((from % 8) - (to % 8), Math.floor(from / 8) - Math.floor(to / 8));
      if (d < bestD) (best = from), (bestD = d);
    }
    if (best < 0 && 'from' in move && move.to === to) best = move.from; // превращение
    if (best >= 0) {
      used.add(best);
      slides.push([best, to, piece]);
    }
  }
  const sound: SoundKind = pos.isCheck() ? 'check' : capture || gone.length > came.length ? 'capture' : 'move';
  const from = 'from' in move ? move.from : move.to;
  return { before, after, slides, from, to: slides.find(([f]) => f === from)?.[1] ?? move.to, sound };
}

const CONTEXT_PLIES = 5;
const T_INTRO = 0.6;
const T_PLY = 0.6;
const T_SLIDE = 0.24;

interface Plan {
  start: Cell[];
  steps: Step[];
  /** Начало каждого хода, с. */
  at: number[];
  momentAt: number;
  captionAt: number;
  end: number;
}

function plan(m: ClipMoment, voiceDur: number): Plan {
  const pos = posFromFen(m.startFen);
  const first = Math.max(0, m.ucis.length - 1 - CONTEXT_PLIES);
  for (const u of m.ucis.slice(0, first)) pos.play(parseUci(u)!);
  const start = cells(pos);
  const steps = m.ucis.slice(first).map((u) => makeStep(pos, u));
  const at = steps.map((_, i) => T_INTRO + i * T_PLY);
  const momentAt = at.at(-1) ?? T_INTRO;
  const captionAt = momentAt + T_SLIDE + 0.1;
  const end = captionAt + Math.max(2.6, voiceDur + 1.1) + 1.8; // в конце — плашка «Сыграй сам»
  return { start, steps, at, momentAt, captionAt, end };
}

const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

function squareXY(sq: number, orient: Side): [number, number] {
  const f = sq % 8;
  const r = Math.floor(sq / 8);
  const col = orient === 'white' ? f : 7 - f;
  const row = orient === 'white' ? 7 - r : r;
  return [BX + col * SQ, BY + row * SQ];
}

/** Переносы по словам под ширину. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > width && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Львы на сильном ходе: заранее раскиданные траектории, чтобы кадры не дёргались. */
const LIONS = Array.from({ length: 14 }, (_, i) => ({
  a: (i / 14) * Math.PI * 2 + 0.3,
  d: 220 + ((i * 53) % 140),
  s: 44 + ((i * 17) % 30),
  delay: (i % 5) * 0.06,
}));

function draw(ctx: CanvasRenderingContext2D, m: ClipMoment, p: Plan, pieces: Map<string, HTMLImageElement>, t: number): void {
  const color = COLORS[m.cls] ?? '#e6e3dc';
  const bad = m.cls === 'blunder' || m.cls === 'mistake';
  // Фон.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#26241f');
  g.addColorStop(1, '#141311');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Шапка.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#6aa84f';
  ctx.font = '900 46px system-ui, "Segoe UI", sans-serif';
  ctx.fillText('♞ CHESS COACH', W / 2, 84);
  ctx.fillStyle = '#a09c93';
  ctx.font = '600 30px system-ui, "Segoe UI", "Segoe UI Emoji", sans-serif';
  ctx.fillText(m.title, W / 2, 140);

  // Текущий ход и его доля.
  let idx = -1;
  for (let i = 0; i < p.at.length; i++) if (t >= p.at[i]) idx = i;
  const step = idx >= 0 ? p.steps[idx] : null;
  const k = step ? ease((t - p.at[idx]) / T_SLIDE) : 1;
  const board = step ? step.after : p.start;
  const isMoment = idx === p.steps.length - 1;

  // Тряска доски на зевке.
  ctx.save();
  if (bad && t > p.momentAt + T_SLIDE && t < p.momentAt + T_SLIDE + 0.6) {
    const q = 1 - (t - p.momentAt - T_SLIDE) / 0.6;
    const amp = (m.cls === 'blunder' ? 16 : 8) * q;
    ctx.translate(Math.sin(t * 90) * amp, Math.cos(t * 70) * amp * 0.5);
  }

  // «ПОТРАЧЕНО»: после хода доска серая.
  const gray = !!m.wasted && t > p.momentAt + T_SLIDE + 0.15;
  if (gray) ctx.filter = 'grayscale(1) brightness(0.65)';
  // Доска.
  ctx.fillStyle = '#000';
  ctx.globalAlpha = 0.35;
  roundRect(ctx, BX - 4, BY + 6, BOARD + 8, BOARD + 8, 8);
  ctx.fill();
  ctx.globalAlpha = 1;
  for (let sq = 0; sq < 64; sq++) {
    const [x, y] = squareXY(sq, m.orientation);
    ctx.fillStyle = (sq % 8) % 2 === Math.floor(sq / 8) % 2 ? '#b58863' : '#f0d9b5';
    ctx.fillRect(x, y, SQ, SQ);
  }
  // Последний ход подсвечен; на моменте — цветом оценки.
  if (step) {
    for (const sq of [step.from, step.to]) {
      const [x, y] = squareXY(sq, m.orientation);
      ctx.fillStyle = isMoment && k >= 1 ? color : 'rgba(155, 199, 0, 0.41)';
      ctx.globalAlpha = isMoment && k >= 1 ? 0.55 : 1;
      ctx.fillRect(x, y, SQ, SQ);
      ctx.globalAlpha = 1;
    }
  }
  // Фигуры: стоящие — из позиции после хода, едущие — между клетками.
  const moving = new Set(step && k < 1 ? step.slides.map(([, to]) => to) : []);
  for (let sq = 0; sq < 64; sq++) {
    const c = board[sq];
    if (!c || moving.has(sq)) continue;
    const [x, y] = squareXY(sq, m.orientation);
    const img = pieces.get(c);
    if (img) ctx.drawImage(img, x, y, SQ, SQ);
  }
  if (step && k < 1) {
    // Взятая фигура ещё стоит, пока на неё едут.
    for (const [, to] of step.slides) {
      const victim = step.before[to];
      if (victim && victim !== step.after[to]) {
        const [x, y] = squareXY(to, m.orientation);
        const img = pieces.get(victim);
        if (img) ctx.drawImage(img, x, y, SQ, SQ);
      }
    }
    for (const [from, to, piece] of step.slides) {
      const [x0, y0] = squareXY(from, m.orientation);
      const [x1, y1] = squareXY(to, m.orientation);
      const img = pieces.get(piece);
      if (img) ctx.drawImage(img, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, SQ, SQ);
    }
  }
  // Пометка хода на клетке.
  if (isMoment && k >= 1 && m.mark && step) {
    const [x, y] = squareXY(step.to, m.orientation);
    const pop = ease((t - p.momentAt - T_SLIDE) / 0.2);
    ctx.save();
    ctx.translate(x + SQ - 6, y + 6);
    ctx.scale(pop, pop);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '900 26px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(m.mark, 0, 1);
    ctx.restore();
  }
  ctx.filter = 'none';
  // Красная вспышка на зевке.
  if (bad && t > p.momentAt + T_SLIDE) {
    const a = Math.max(0, 0.45 - (t - p.momentAt - T_SLIDE) * 0.8);
    if (a > 0) {
      ctx.fillStyle = `rgba(217, 30, 30, ${a})`;
      ctx.fillRect(BX, BY, BOARD, BOARD);
    }
  }
  ctx.restore();

  // Львы на сильном ходе.
  if ((m.cls === 'best' || m.cls === 'good') && t > p.momentAt + T_SLIDE) {
    const dt = t - p.momentAt - T_SLIDE;
    ctx.textBaseline = 'middle';
    for (const l of LIONS) {
      const q = (dt - l.delay) / 1.4;
      if (q <= 0 || q >= 1) continue;
      const r = ease(q) * l.d;
      ctx.globalAlpha = q < 0.7 ? 1 : (1 - q) / 0.3;
      ctx.font = `${l.s}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
      ctx.fillText('🦁', W / 2 + Math.cos(l.a) * r, BY + BOARD / 2 + Math.sin(l.a) * r);
    }
    ctx.globalAlpha = 1;
  }

  const after = t - p.momentAt - T_SLIDE;
  // Победа: моаи.
  if ((m.aura ?? 0) >= 3000 && after > 0 && after < 2.6) {
    const q = ease(after / 0.3);
    ctx.globalAlpha = Math.min(1, (2.6 - after) / 0.4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(220 * q)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillText('🗿', W / 2, BY + BOARD / 2 - 40);
    ctx.font = '900 64px system-ui, sans-serif';
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#000';
    ctx.strokeText('СИГМА', W / 2, BY + BOARD / 2 + 120);
    ctx.fillStyle = '#f1c84b';
    ctx.fillText('СИГМА', W / 2, BY + BOARD / 2 + 120);
    ctx.globalAlpha = 1;
  }
  // «ПОТРАЧЕНО» поперёк доски.
  if (m.wasted && after > 0.15) {
    const q = ease((after - 0.15) / 0.3);
    const cy = BY + BOARD / 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(BX, cy - 60, BOARD, 120);
    ctx.save();
    ctx.translate(W / 2, cy);
    ctx.scale(1.6 - 0.6 * q, 1.6 - 0.6 * q);
    ctx.globalAlpha = q;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 92px "Arial Black", Impact, system-ui, sans-serif';
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#000';
    ctx.strokeText('ПОТРАЧЕНО', 0, 4);
    ctx.fillStyle = '#d23434';
    ctx.fillText('ПОТРАЧЕНО', 0, 4);
    ctx.restore();
  }
  // Аура: всплывает над доской и держится, пока идёт реплика.
  if (m.aura && after > 0) {
    const q = ease(after / 0.25);
    const fade = Math.min(1, Math.max(0, (p.end - 1.8 - p.momentAt - after) / 0.5));
    ctx.save();
    ctx.globalAlpha = q * fade;
    ctx.translate(W / 2, BY + (m.wasted ? 120 : 90) - 20 * q);
    const sc = 0.5 + 0.5 * q;
    ctx.scale(sc, sc);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = Math.abs(m.aura) >= 1000;
    ctx.font = `900 ${big ? 76 : 58}px system-ui, "Segoe UI", sans-serif`;
    const txt = `${fmtAura(m.aura)} АУРЫ`;
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.strokeText(txt, 0, 0);
    ctx.fillStyle = m.aura > 0 ? '#7ee07e' : '#ff4d4d';
    ctx.fillText(txt, 0, 0);
    ctx.restore();
  }
  // Чат «стрима» поверх доски, как комментарии в эфире.
  if (m.chat?.length && after > 0.3) {
    const shown = m.chat.slice(0, Math.min(m.chat.length, 1 + Math.floor((after - 0.3) / 0.35)));
    const last = shown.slice(-4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let y = BY + BOARD - 22;
    for (let i = last.length - 1; i >= 0; i--) {
      const [nick, text] = last[i];
      const donation = nick.startsWith('💸');
      ctx.font = '700 22px system-ui, "Segoe UI", "Segoe UI Emoji", sans-serif';
      const nw = ctx.measureText(nick + (donation ? '' : ': ')).width;
      ctx.font = '600 22px system-ui, "Segoe UI", "Segoe UI Emoji", sans-serif';
      const tw = ctx.measureText(text).width;
      const w = Math.min(BOARD - 30, (donation ? Math.max(nw, tw) : nw + tw) + 24);
      const h = donation ? 64 : 38;
      ctx.fillStyle = donation ? 'rgba(140, 60, 200, 0.92)' : 'rgba(0, 0, 0, 0.62)';
      roundRect(ctx, BX + 14, y - h + 19, w, h, 12);
      ctx.fill();
      ctx.font = '700 22px system-ui, "Segoe UI", "Segoe UI Emoji", sans-serif';
      ctx.fillStyle = donation ? '#ffe27a' : '#9fd0ff';
      if (donation) {
        ctx.fillText(nick, BX + 26, y - 26);
        ctx.font = '600 22px system-ui, "Segoe UI", "Segoe UI Emoji", sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(text, BX + 26, y);
      } else {
        ctx.fillText(nick + ': ', BX + 26, y);
        ctx.font = '600 22px system-ui, "Segoe UI", "Segoe UI Emoji", sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(text, BX + 26 + nw, y);
      }
      y -= h + 8;
    }
  }

  // Подпись: оценка и реплика тренера.
  if (t >= p.captionAt) {
    const q = ease((t - p.captionAt) / 0.25);
    const top = BY + BOARD + 36;
    ctx.save();
    ctx.globalAlpha = q;
    ctx.translate(W / 2, top + 140);
    ctx.scale(0.85 + 0.15 * q, 0.85 + 0.15 * q);
    ctx.translate(-W / 2, -(top + 140));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.font = '800 34px system-ui, "Segoe UI", sans-serif';
    ctx.fillText(m.verdict, W / 2, top + 36);
    if (m.phrase) {
      let size = 52;
      let lines: string[];
      do {
        ctx.font = `900 ${size}px system-ui, "Segoe UI", "Segoe UI Emoji", sans-serif`;
        lines = wrapText(ctx, m.phrase, W - 70);
        size -= 4;
      } while (lines.length * (size + 14) > 170 && size > 26);
      const lh = size + 14;
      ctx.lineJoin = 'round';
      lines.forEach((line, i) => {
        const y = top + 96 + i * lh;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 8;
        ctx.strokeText(line, W / 2, y);
        ctx.fillStyle = '#fff';
        ctx.fillText(line, W / 2, y);
      });
    }
    ctx.restore();
  }

  // Конец: плашка с призывом.
  const ctaAt = p.end - 1.8;
  if (t >= ctaAt) {
    const q = ease((t - ctaAt) / 0.3);
    ctx.globalAlpha = q;
    ctx.fillStyle = '#6aa84f';
    roundRect(ctx, 100, H - 112, W - 200, 68, 34);
    ctx.fill();
    ctx.fillStyle = '#10200a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 30px system-ui, "Segoe UI", sans-serif';
    ctx.fillText('Сыграй сам — это бесплатно', W / 2, H - 77);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = '#6f6b63';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText(SITE_URL.replace(/^https?:\/\//, '') || 'Chess Coach', W / 2, H - 14);
}

function pickMime(): { mime: string; ext: string } {
  const opts: [string, string][] = [
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [mime, ext] of opts) if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  return { mime: '', ext: 'webm' };
}

export function clipSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
}

export interface Recording {
  blob: Blob;
  ext: string;
}

/**
 * Записывает клип. canvas показывается пользователю как живое превью.
 * voice — адрес записи реплики (mp3 или data:) либо null.
 */
export async function recordClip(
  m: ClipMoment,
  voice: string | null,
  canvas: HTMLCanvasElement,
  onProgress?: (q: number) => void,
): Promise<Recording> {
  canvas.width = W;
  canvas.height = H;
  const ctx2d = canvas.getContext('2d')!;
  const pieces = await loadPieces();
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  let voiceBuf: AudioBuffer | null = null;
  if (voice) {
    try {
      voiceBuf = await ac.decodeAudioData(await (await fetch(voice)).arrayBuffer());
    } catch {
      voiceBuf = null;
    }
  }
  const p = plan(m, voiceBuf?.duration ?? 0);
  draw(ctx2d, m, p, pieces, 0);

  const stream = canvas.captureStream(FPS);
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
  const { mime, ext } = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 5_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));

  await ac.resume();
  const t0 = ac.currentTime + 0.05;
  p.steps.forEach((s, i) => scheduleSound(s.sound, ac, dest, t0 + p.at[i]));
  const hit = t0 + p.momentAt + T_SLIDE;
  if (m.wasted) scheduleSound('sad', ac, dest, hit + 0.1);
  else if (m.cls === 'blunder') scheduleSound('boom', ac, dest, hit);
  else if (m.cls === 'mistake') scheduleSound('womp', ac, dest, hit);
  else if ((m.aura ?? 0) >= 2000) scheduleSound('sigma', ac, dest, hit);
  if (m.chat?.some(([n]) => n.startsWith('💸'))) scheduleSound('donate', ac, dest, hit + 1.2);
  if (voiceBuf) {
    const src = ac.createBufferSource();
    src.buffer = voiceBuf;
    const gain = ac.createGain();
    gain.gain.value = 1.6;
    src.connect(gain).connect(dest);
    src.start(t0 + p.captionAt + 0.05);
  }
  rec.start(250);

  await new Promise<void>((resolve) => {
    const frame = () => {
      const t = ac.currentTime - t0;
      draw(ctx2d, m, p, pieces, Math.max(0, t));
      onProgress?.(Math.min(1, t / p.end));
      if (t >= p.end) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  // Последний кадр держим ещё немного: кодировщик дописывает хвост с задержкой.
  draw(ctx2d, m, p, pieces, p.end);
  await new Promise((r) => setTimeout(r, 400));
  rec.stop();
  await done;
  stream.getTracks().forEach((tr) => tr.stop());
  void ac.close();
  return { blob: new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' }), ext };
}

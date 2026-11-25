// Общие шахматные помощники: позиция, запись ходов, оценки.
import { Chess } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import type { Move, NormalMove } from 'chessops/types';
import { makeUci, parseSquare, parseUci } from 'chessops/util';
import type { Config } from 'chessground/config';
import type { Key } from 'chessground/types';
import type { Line } from './engine';

export type Side = 'white' | 'black';

export const posFromFen = (fen: string): Chess => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
export const fenOf = (pos: Chess): string => makeFen(pos.toSetup());

/**
 * Запись хода как у движка: рокировка — король на две клетки (e1g1), а не «король бьёт ладью».
 * В шахматах 960 наоборот — король бьёт свою ладью (b1h1), так её понимает Stockfish с UCI_Chess960.
 */
export function uciOf(pos: Chess, move: Move, chess960 = false): string {
  if ('from' in move && !chess960) {
    const piece = pos.board.get(move.from);
    const target = pos.board.get(move.to);
    if (piece?.role === 'king' && target?.role === 'rook' && target.color === piece.color) {
      const file = move.to > move.from ? 6 : 2;
      return makeUci({ from: move.from, to: (move.from >> 3) * 8 + file });
    }
  }
  return makeUci(move);
}

export type PromotionRole = 'queen' | 'rook' | 'bishop' | 'knight';

/** Ход пешки на последнюю горизонталь — нужно выбрать фигуру. */
export function isPromotion(pos: Chess, orig: string, dest: string): boolean {
  const from = parseSquare(orig);
  const to = parseSquare(dest);
  if (from === undefined || to === undefined) return false;
  const rank = to >> 3;
  return pos.board.get(from)?.role === 'pawn' && (rank === 0 || rank === 7);
}

/** Ход пользователя с доски; пешка на последней горизонтали превращается в promotion (по умолчанию ферзь). */
export function userMove(pos: Chess, orig: string, dest: string, promotion: PromotionRole = 'queen'): NormalMove | undefined {
  const from = parseSquare(orig);
  const to = parseSquare(dest);
  if (from === undefined || to === undefined) return undefined;
  const move: NormalMove = { from, to };
  if (isPromotion(pos, orig, dest)) move.promotion = promotion;
  return pos.isLegal(move) ? move : undefined;
}

/** Звук хода: взятие (в том числе на проходе) или обычный ход. Вызывать ДО pos.play(move). */
export function isCapture(pos: Chess, move: Move): boolean {
  if (!('from' in move)) return false;
  const piece = pos.board.get(move.from);
  const target = pos.board.get(move.to);
  if (target && target.color !== piece?.color) return true;
  return piece?.role === 'pawn' && (move.from & 7) !== (move.to & 7) && !target;
}

/** Ключ позиции для троекратного повторения: расстановка, очередь хода, рокировки, взятие на проходе. */
export const repetitionKey = (pos: Chess): string => fenOf(pos).split(' ').slice(0, 4).join(' ');

/** Линия движка в обычной записи: «12. Nf3 Nc6 13. Bb5». */
export function sanLine(fen: string, ucis: string[], max = 6): string {
  const pos = posFromFen(fen);
  const out: string[] = [];
  for (const uci of ucis.slice(0, max)) {
    const move = parseUci(uci);
    if (!move || !pos.isLegal(move)) break;
    if (pos.turn === 'white') out.push(`${pos.fullmoves}.`);
    else if (out.length === 0) out.push(`${pos.fullmoves}…`);
    out.push(makeSan(pos, move));
    pos.play(move);
  }
  return out.join(' ');
}

export function sanOf(fen: string, uci: string): string {
  const pos = posFromFen(fen);
  const move = parseUci(uci);
  return move && pos.isLegal(move) ? makeSan(pos, move) : uci;
}

/** Шансы белых на победу в процентах (формула Lichess). */
export const winPct = (cp: number): number => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

export const winPctFor = (cp: number, side: Side): number => (side === 'white' ? winPct(cp) : 100 - winPct(cp));

export function fmtEval(line: Pick<Line, 'cp' | 'mate'>): string {
  if (Math.abs(line.cp) >= 10000) return line.cp > 0 ? 'мат, 1–0' : 'мат, 0–1';
  if (line.mate !== undefined) return `${line.mate > 0 ? '' : '−'}М${Math.abs(line.mate)}`;
  const v = line.cp / 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
}

export type Grade = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export const GRADE_LABEL: Record<Grade, string> = {
  best: 'Лучший ход',
  good: 'Хороший ход',
  inaccuracy: 'Неточность',
  mistake: 'Ошибка',
  blunder: 'Зевок',
};

export const GRADE_MARK: Record<Grade, string> = { best: '', good: '', inaccuracy: '?!', mistake: '?', blunder: '??' };

/** Потеря в сантипешках для стороны side; оценки обрезаны до ±15 пешек, чтобы мат не давал тысячи. */
export function cpLossFor(beforeCp: number, afterCp: number, side: Side): number {
  const clamp = (v: number) => Math.max(-1500, Math.min(1500, v));
  const diff = clamp(beforeCp) - clamp(afterCp);
  return Math.max(0, side === 'white' ? diff : -diff);
}

/**
 * Оценка хода. loss — потеря шансов на победу в п. п., cpLoss — потеря в сантипешках.
 * Шансы ловят ошибки в равной позиции; сантипешки — зевки, когда уже выигрываешь или проигрываешь
 * (при +9 отданный слон почти не меняет шансы, но это всё равно зевок).
 */
export function grade(loss: number, isBest: boolean, cpLoss = 0): Grade {
  if (isBest) return 'best';
  if (loss >= 20 || cpLoss >= 230) return 'blunder';
  if (loss >= 10 || cpLoss >= 120) return 'mistake';
  if (loss >= 5 || cpLoss >= 60) return 'inaccuracy';
  return 'good';
}

/**
 * Точность одного хода, 0–100, по формуле Lichess. Потеря берётся как бóльшая из двух:
 * шансы на победу (п. п.) и сантипешки / 11,5 — те же пороги, что у оценки хода (20 п. п. ≈ 230 сп = зевок).
 * Без сантипешек зевок в уже проигранной позиции почти не снижал бы точность.
 */
export function moveAccuracy(winLoss: number, cpLoss = 0): number {
  const loss = Math.max(0, winLoss, cpLoss / 11.5);
  const a = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

/**
 * Точность за партию, как на Lichess: среднее арифметическое и среднее гармоническое пополам.
 * Гармоническое сильно тянет вниз за провалы; каждый ход не ниже 10%, чтобы один зевок не обнулял всё.
 */
export function gameAccuracy(accs: number[]): number | null {
  if (!accs.length) return null;
  const mean = accs.reduce((s, a) => s + a, 0) / accs.length;
  const harmonic = accs.length / accs.reduce((s, a) => s + 1 / Math.max(10, a), 0);
  return (mean + harmonic) / 2;
}

/** Оценка конечной позиции без движка; null — партия не окончена. */
export function terminalLine(pos: Chess): Line | null {
  if (!pos.isEnd()) return null;
  const winner = pos.outcome()?.winner;
  if (!winner) return { multipv: 1, depth: 0, cp: 0, pv: [] };
  const sign = winner === 'white' ? 1 : -1;
  return { multipv: 1, depth: 0, cp: sign * 10000, pv: [] };
}

/** Состояние доски chessground для позиции. movable — чьими фигурами можно ходить. */
export function boardState(pos: Chess, movable: Side | 'both' | null, lastUci?: string, chess960 = false): Config {
  return {
    fen: fenOf(pos),
    turnColor: pos.turn,
    check: pos.isCheck(),
    lastMove: lastUci ? [lastUci.slice(0, 2) as Key, lastUci.slice(2, 4) as Key] : undefined,
    movable: {
      free: false,
      color: movable ?? undefined,
      dests: movable ? (chessgroundDests(pos, { chess960 }) as Map<Key, Key[]>) : new Map(),
      showDests: true,
    },
  };
}

export function resultText(pos: Chess): string | null {
  if (!pos.isEnd()) return null;
  if (pos.isCheckmate()) return pos.turn === 'white' ? 'Мат. Победили чёрные' : 'Мат. Победили белые';
  if (pos.isStalemate()) return 'Пат. Ничья';
  return 'Ничья';
}

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

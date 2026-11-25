// Счёт против бота и примерный рейтинг игрока. Хранится в localStorage приложения, переживает перезапуск.

export interface Stats {
  rating: number;
  peak: number;
  games: number;
  /** по уровням бота: [победы, ничьи, поражения] */
  byLevel: Record<number, [number, number, number]>;
  bestStreak: number;
  /** Аура за все партии. */
  aura: number;
  bestAura: number;
}

const KEY = 'chesscoach.stats.v1';
const START: Stats = { rating: 1200, peak: 1200, games: 0, byLevel: {}, bestStreak: 0, aura: 0, bestAura: 0 };

export function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...START, ...JSON.parse(raw) };
  } catch {
    /* хранилище недоступно — начинаем с нуля */
  }
  return structuredClone(START);
}

function save(s: Stats): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* не сохранилось — не страшно */
  }
}

/**
 * Записывает партию. score: 1 — победа, 0.5 — ничья, 0 — поражение.
 * Рейтинг — обычная формула Эло: K = 40 первые 20 партий, потом 24.
 */
export function recordGame(level: number, botElo: number, score: 0 | 0.5 | 1, streak: number): { before: number; after: number } {
  const s = loadStats();
  const before = s.rating;
  const expected = 1 / (1 + 10 ** ((botElo - s.rating) / 400));
  const k = s.games < 20 ? 40 : 24;
  s.rating = Math.max(100, Math.round(s.rating + k * (score - expected)));
  s.peak = Math.max(s.peak, s.rating);
  s.games++;
  const row = s.byLevel[level] ?? [0, 0, 0];
  row[score === 1 ? 0 : score === 0.5 ? 1 : 2]++;
  s.byLevel[level] = row;
  s.bestStreak = Math.max(s.bestStreak, streak);
  save(s);
  return { before, after: s.rating };
}

/** Серию тоже сохраняем по ходу партии, чтобы рекорд не терялся, если партию бросили. */
export function noteStreak(streak: number): void {
  const s = loadStats();
  if (streak > s.bestStreak) {
    s.bestStreak = streak;
    save(s);
  }
}

/** Аура партии в общий счёт. Возвращает новый общий счёт. */
export function addAura(gameAura: number): number {
  const s = loadStats();
  s.aura += gameAura;
  s.bestAura = Math.max(s.bestAura, gameAura);
  save(s);
  return s.aura;
}

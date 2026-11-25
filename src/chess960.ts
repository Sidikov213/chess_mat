// Шахматы Фишера (960): случайная расстановка фигур первой горизонтали по правилам —
// слоны на полях разного цвета, король между ладьями. Пешки и всё остальное как обычно.

export const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Расстановка по номеру 0–959 (нумерация Шарля Шерна, 518 — обычная). */
export function backRank(n: number): string {
  const rank: (string | null)[] = Array(8).fill(null);
  let x = n;
  rank[2 * (x % 4) + 1] = 'B'; // светлопольный слон: b, d, f, h
  x = Math.floor(x / 4);
  rank[2 * (x % 4)] = 'B'; // тёмнопольный: a, c, e, g
  x = Math.floor(x / 4);
  const free = () => rank.flatMap((p, i) => (p ? [] : [i]));
  rank[free()[x % 6]] = 'Q';
  x = Math.floor(x / 6);
  // Два коня на оставшихся 5 полях: 10 вариантов.
  const knights = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]][x];
  const f = free();
  rank[f[knights[0]]] = 'N';
  rank[f[knights[1]]] = 'N';
  // Оставшиеся три поля: ладья, король, ладья.
  const [a, b, c] = free();
  rank[a] = 'R';
  rank[b] = 'K';
  rank[c] = 'R';
  return rank.join('');
}

export function fen960(n = Math.floor(Math.random() * 960)): string {
  const r = backRank(n);
  return `${r.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${r} w KQkq - 0 1`;
}

export const isStandardFen = (fen: string) => fen.split(' ')[0] === STANDARD_FEN.split(' ')[0];

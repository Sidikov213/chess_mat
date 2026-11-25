// История партий: каждая законченная партия сохраняется в localStorage (последние 300).
export interface SavedGame {
  id: string;
  date: number;
  mode: 'bot' | 'local' | 'net';
  /** Против кого: персонаж, «Друг за компьютером», имя по сети. */
  opponent: string;
  /** За кого играл владелец приложения; у партии за одним компьютером — null. */
  myColor: 'white' | 'black' | null;
  /** 1 — победа владельца (или белых, если myColor null), 0.5 — ничья, 0 — поражение. */
  score: 0 | 0.5 | 1;
  reason: string;
  opening: string | null;
  plies: number;
  accuracy: number | null;
  chess960: boolean;
  pgn: string;
}

const KEY = 'chesscoach.history.v1';
const MAX = 300;

export function loadHistory(): SavedGame[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedGame[]) : [];
  } catch {
    return [];
  }
}

export function saveGame(g: Omit<SavedGame, 'id' | 'date'>): void {
  const list = loadHistory();
  list.unshift({ ...g, id: Math.random().toString(36).slice(2), date: Date.now() });
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* хранилище переполнено или недоступно */
  }
}

export function deleteGame(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadHistory().filter((g) => g.id !== id)));
  } catch {
    /* не страшно */
  }
}

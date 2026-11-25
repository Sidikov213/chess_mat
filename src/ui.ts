// Общие кусочки интерфейса для обоих режимов игры.
import type { PromotionRole, Side } from './shared';

export const TIME_CONTROLS = [
  { name: 'Без часов', base: 0, inc: 0 },
  { name: '1 + 0 (пуля)', base: 1, inc: 0 },
  { name: '3 + 2 (блиц)', base: 3, inc: 2 },
  { name: '5 + 0 (блиц)', base: 5, inc: 0 },
  { name: '10 + 0 (рапид)', base: 10, inc: 0 },
  { name: '15 + 10 (рапид)', base: 15, inc: 10 },
];
export type TimeControl = (typeof TIME_CONTROLS)[number];

export const LOW_TIME_MS = 10_000;

export function fmtClock(ms: number): string {
  const t = Math.max(0, ms);
  if (t < LOW_TIME_MS) return `${Math.floor(t / 1000)}.${Math.floor((t % 1000) / 100)}`;
  const s = Math.ceil(t / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Окно выбора фигуры поверх доски. null — щёлкнули мимо, ход отменён. */
export function choosePromotion(box: HTMLElement, color: Side): Promise<PromotionRole | null> {
  box.replaceChildren();
  return new Promise((resolve) => {
    const done = (r: PromotionRole | null) => {
      box.classList.add('hidden');
      box.onclick = null;
      resolve(r);
    };
    for (const role of ['queen', 'knight', 'rook', 'bishop'] as const) {
      const p = document.createElement('piece');
      p.className = `${role} ${color}`;
      p.title = { queen: 'Ферзь', knight: 'Конь', rook: 'Ладья', bishop: 'Слон' }[role];
      p.onclick = (e) => {
        e.stopPropagation();
        done(role);
      };
      box.append(p);
    }
    box.onclick = () => done(null);
    box.classList.remove('hidden');
  });
}

/** Список ходов «1. e4 e5 2. Nf3 …» в сетке. */
export function renderMoveList(list: HTMLElement, sans: string[]): void {
  list.replaceChildren();
  for (let i = 0; i < sans.length; i += 2) {
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    list.append(num);
    for (const san of [sans[i], sans[i + 1]]) {
      const el = document.createElement('span');
      el.className = 'mv';
      el.textContent = san ?? '';
      list.append(el);
    }
  }
  list.scrollTop = list.scrollHeight;
}

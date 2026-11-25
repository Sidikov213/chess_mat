// Достижения: условия, хранение в localStorage, всплывашка при получении.
import { playSound } from './sounds';

export interface Achievement {
  id: string;
  emoji: string;
  title: string;
  desc: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_game', emoji: '🎬', title: 'Первая кровь', desc: 'Сыграть первую партию' },
  { id: 'first_win', emoji: '🥇', title: 'Первая победа', desc: 'Выиграть партию' },
  { id: 'ten_games', emoji: '🔁', title: 'Втянулся', desc: 'Сыграть 10 партий' },
  { id: 'fifty_games', emoji: '🧟', title: 'Задрот', desc: 'Сыграть 50 партий' },
  { id: 'quick_mate', emoji: '⚡', title: 'Блиц-крик', desc: 'Поставить мат за 15 ходов или быстрее' },
  { id: 'mate_knight', emoji: '🐴', title: 'Конь в пальто', desc: 'Поставить мат конём' },
  { id: 'mate_pawn', emoji: '🗡️', title: 'Пешка-убийца', desc: 'Поставить мат пешкой' },
  { id: 'mate_bishop', emoji: '⛪', title: 'Слон в посудной лавке', desc: 'Поставить мат слоном' },
  { id: 'mate_castle', emoji: '🏰', title: 'Рокировка с матом', desc: 'Поставить мат рокировкой' },
  { id: 'underpromote', emoji: '🎭', title: 'Не ферзём единым', desc: 'Превратить пешку не в ферзя' },
  { id: 'en_passant', emoji: '👻', title: 'На проходе', desc: 'Взять пешку на проходе' },
  { id: 'streak5', emoji: '🔥', title: 'Пятёрка левь', desc: 'Пять сильных ходов подряд против бота' },
  { id: 'streak10', emoji: '🦁', title: 'Царь зверей', desc: 'Десять сильных ходов подряд против бота' },
  { id: 'clean_game', emoji: '🧼', title: 'Без хуйни', desc: 'Партия против бота от 15 ходов без зевков и ошибок' },
  { id: 'accuracy90', emoji: '🎯', title: 'Снайпер', desc: 'Точность 90% и выше в партии от 15 ходов' },
  { id: 'comeback', emoji: '🐦‍🔥', title: 'Феникс', desc: 'Победить бота из позиции −5 и хуже' },
  { id: 'time_win', emoji: '⏱️', title: 'Задушил по времени', desc: 'Выиграть по времени' },
  { id: 'marathon', emoji: '🏃', title: 'Марафонец', desc: 'Партия длиннее 80 ходов' },
  { id: 'resigned', emoji: '🏳️', title: 'Белый флаг', desc: 'Сдаться. Бывает.' },
  { id: 'fools_mate', emoji: '🤡', title: 'Дурачок', desc: 'Получить мат за 4 хода или быстрее' },
  { id: 'beat_grandpa', emoji: '👴', title: 'Деда уважил', desc: 'Победить Деда Магомеда' },
  { id: 'beat_troll', emoji: '🤡', title: 'Тролля затроллил', desc: 'Победить Тролля Шамиля' },
  { id: 'beat_tiger', emoji: '🐯', title: 'Укротитель тигра', desc: 'Победить Тигра Расула' },
  { id: 'beat_taxi', emoji: '🚕', title: 'Доехал бесплатно', desc: 'Победить Дядю Саида' },
  { id: 'beat_eagle', emoji: '🦅', title: 'Сбил орла', desc: 'Победить Орла Хабиба' },
  { id: 'beat_prof', emoji: '🎓', title: 'Профессора — на пенсию', desc: 'Победить Профессора' },
  { id: 'beat_machine', emoji: '🤖', title: 'Восстание людей', desc: 'Победить Машину. Легенда.' },
  { id: 'rating1500', emoji: '📈', title: 'Полторашка', desc: 'Набрать рейтинг 1500' },
  { id: 'rating2000', emoji: '🚀', title: 'Двушка', desc: 'Набрать рейтинг 2000' },
  { id: 'local_game', emoji: '🛋️', title: 'Диванный турнир', desc: 'Сыграть партию за одним компьютером' },
  { id: 'net_game', emoji: '🌐', title: 'По проводам', desc: 'Сыграть партию по сети' },
  { id: 'net_win', emoji: '🏴‍☠️', title: 'Сетевой хищник', desc: 'Победить друга по сети' },
  { id: 'win960', emoji: '🎲', title: 'Фишер одобряет', desc: 'Выиграть в шахматы 960' },
];

const KEY = 'chesscoach.achievements.v1';

export function unlockedMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

let queue: Achievement[] = [];
let showing = false;

/** Выдаёт достижение (один раз) и показывает всплывашку. */
export function unlock(id: string): void {
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (!a) return;
  const map = unlockedMap();
  if (map[id]) return;
  map[id] = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* без сохранения */
  }
  queue.push(a);
  if (!showing) showNext();
}

function showNext(): void {
  const a = queue.shift();
  if (!a) {
    showing = false;
    return;
  }
  showing = true;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-emoji">${a.emoji}</span><div><div class="toast-head">Достижение получено!</div>` +
    `<div class="toast-title"></div><div class="toast-desc"></div></div>`;
  el.querySelector('.toast-title')!.textContent = a.title;
  el.querySelector('.toast-desc')!.textContent = a.desc;
  document.body.append(el);
  playSound('notify');
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => {
    el.remove();
    showNext();
  }, 3700);
}

/** Сведения о законченной партии для проверки достижений. */
export interface GameFacts {
  mode: 'bot' | 'local' | 'net';
  /** Победил ли владелец приложения (для партии за одним компьютером — кто-то из двоих). */
  won: boolean;
  lost: boolean;
  how: 'mate' | 'time' | 'resign' | 'draw' | 'other';
  /** Фигура, поставившая мат (если мат поставил игрок), и был ли это мат рокировкой. */
  matingRole?: string;
  castleMate?: boolean;
  /** Полуходы партии. */
  plies: number;
  accuracy: number | null;
  blunders: number;
  mistakes: number;
  personaId?: string;
  /** Худшая оценка для игрока за партию, в пешках (−5 и хуже — для «Феникса»). */
  worstEval?: number;
  chess960: boolean;
  gamesPlayed: number;
  rating?: number;
}

export function checkGame(f: GameFacts): void {
  unlock('first_game');
  if (f.gamesPlayed >= 10) unlock('ten_games');
  if (f.gamesPlayed >= 50) unlock('fifty_games');
  if (f.plies > 160) unlock('marathon');
  if (f.mode === 'local') unlock('local_game');
  if (f.mode === 'net') unlock('net_game');
  if (f.how === 'resign' && f.lost) unlock('resigned');
  if (f.how === 'mate' && f.lost && f.plies <= 8) unlock('fools_mate');
  const myMoves = Math.ceil(f.plies / 2);
  if (myMoves >= 15 && f.accuracy !== null && f.accuracy >= 90) unlock('accuracy90');
  if (f.mode === 'bot' && myMoves >= 15 && f.accuracy !== null && f.blunders === 0 && f.mistakes === 0) unlock('clean_game');
  if (f.rating !== undefined && f.rating >= 1500) unlock('rating1500');
  if (f.rating !== undefined && f.rating >= 2000) unlock('rating2000');
  if (!f.won) return;
  unlock('first_win');
  if (f.how === 'time') unlock('time_win');
  if (f.chess960) unlock('win960');
  if (f.mode === 'net') unlock('net_win');
  if (f.how === 'mate') {
    if (f.plies <= 30) unlock('quick_mate');
    if (f.castleMate) unlock('mate_castle');
    else if (f.matingRole === 'knight') unlock('mate_knight');
    else if (f.matingRole === 'pawn') unlock('mate_pawn');
    else if (f.matingRole === 'bishop') unlock('mate_bishop');
  }
  if (f.mode === 'bot') {
    if (f.worstEval !== undefined && f.worstEval <= -5) unlock('comeback');
    if (f.personaId) unlock(`beat_${f.personaId}`);
  }
}

/** Содержимое окна «Достижения». */
export function renderAchievements(box: HTMLElement): void {
  const map = unlockedMap();
  const got = ACHIEVEMENTS.filter((a) => map[a.id]).length;
  box.replaceChildren();
  const head = document.createElement('div');
  head.className = 'ach-progress';
  head.textContent = `Получено ${got} из ${ACHIEVEMENTS.length}`;
  box.append(head);
  const grid = document.createElement('div');
  grid.className = 'ach-grid';
  for (const a of ACHIEVEMENTS) {
    const el = document.createElement('div');
    el.className = `ach ${map[a.id] ? 'got' : 'locked'}`;
    const date = map[a.id] ? new Date(map[a.id]).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
    el.innerHTML = `<span class="ach-emoji">${a.emoji}</span><div><div class="ach-title"></div><div class="ach-desc"></div></div>`;
    el.querySelector('.ach-title')!.textContent = a.title + (date ? ` · ${date}` : '');
    el.querySelector('.ach-desc')!.textContent = a.desc;
    grid.append(el);
  }
  box.append(grid);
}

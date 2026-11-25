// Боты-персонажи: сила (уровень Stockfish), стиль выбора хода и фразы, которыми бот подкалывает игрока.
import type { Chess } from 'chessops/chess';
import { parseUci } from 'chessops/util';
import type { Line } from './engine';
import type { Side } from './shared';

export type Style = 'kid' | 'solid' | 'troll' | 'aggressive' | 'normal';
export type BotEvent = 'start' | 'capture' | 'check' | 'gloat' | 'impressed' | 'win' | 'lose' | 'draw';

export interface Persona {
  id: string;
  name: string;
  emoji: string;
  about: string;
  /** Примерная сила (Эло) — для рейтинга игрока. */
  elo: number;
  skill: number;
  ms: number;
  style: Style;
  /** Насколько хуже лучшего (в сантипешках) бот готов сыграть ход «в своём стиле». */
  tolerance: number;
  phrases: Record<BotEvent, string[]>;
}

export const PERSONAS: Persona[] = [
  {
    id: 'kid', name: 'Малой', emoji: '👶', about: 'Только научился ходить конём. Иногда.', elo: 700, skill: 0, ms: 50,
    style: 'kid', tolerance: 250,
    phrases: {
      start: ['Я буду белыми! Ой, нет… Ладно, погнали!', 'Мама сказала, ты лох. Проверим!'],
      capture: ['Ням! Скушал!', 'Хе-хе, моё!', 'Это теперь мой ферзь… или конь… короче, моё!'],
      check: ['ШАХ! Я правильно сказал?', 'Шах-шах-шах!'],
      gloat: ['Ахахах, ты чё, хуже меня играешь?!', 'Даже я так не зеваю, брат!'],
      impressed: ['Ого… а так можно было?', 'Нечестно, ты читер!'],
      win: ['Я ВЫИГРАЛ! Пойду расскажу маме!', 'Ты проиграл ребёнку, ебень!'],
      lose: ['Нечестно! Ещё раз!', 'Я поддавался, понял?'],
      draw: ['Ничья — это когда никто не выиграл? Скучно.'],
    },
  },
  {
    id: 'grandpa', name: 'Дед', emoji: '👴', about: 'Играет осторожно, не любит размены. Ворчит.', elo: 1000, skill: 3, ms: 120,
    style: 'solid', tolerance: 60,
    phrases: {
      start: ['Садись, внучок. Покажу, как в наше время играли.', 'Не торопись. Шахматы — это тебе не тикток.'],
      capture: ['Это я заберу. Нечего фигуры разбрасывать.', 'Эх, молодёжь… всё раздаёте.'],
      check: ['Шах, внучок. Подумай-ка.', 'Королю твоему неуютно, а?'],
      gloat: ['Ну куда ты пошёл, бестолочь?', 'В моё время за такой ход по ушам давали!'],
      impressed: ['Хм. Неплохо, неплохо.', 'Вот это по-нашему, внучок.'],
      win: ['Учись, пока дед живой.', 'Иди ещё поиграй, потом приходи.'],
      lose: ['Ладно, ладно… повезло тебе сегодня.', 'Старый я стал. Молодец, внучок.'],
      draw: ['Мир — это хорошо. Ничья.'],
    },
  },
  {
    id: 'troll', name: 'Тролль', emoji: '🤡', about: 'Гуляет королём, двигает крайние пешки и ржёт.', elo: 1200, skill: 6, ms: 150,
    style: 'troll', tolerance: 90,
    phrases: {
      start: ['Сыграю одной левой. Нет, одним королём.', 'Готовься к кринжу, брат.'],
      capture: ['Опа, халява!', 'Спасибо за подарок, ебень!', 'Мне это пригодится. Нет. Но всё равно моё.'],
      check: ['Шах! Чё, страшно?', 'Тук-тук! Шах!'],
      gloat: ['АХАХАХАХ, ты это серьёзно?!', 'Скриню и кидаю в чат, ебень!', 'Бро, это был ход или ты чихнул?'],
      impressed: ['Ой, ну всё, всё, не выпендривайся.', 'Повезло, ебень.'],
      win: ['GG EZ, ебень!', 'Проиграл клоуну. Подумай над этим.'],
      lose: ['Я специально, это был стрим.', 'Ладно, ты не ебень. Сегодня.'],
      draw: ['Ничья? Ну хоть не проиграл, ахах.'],
    },
  },
  {
    id: 'tiger', name: 'Тигр', emoji: '🐯', about: 'Атакует. Любит шахи, взятия и кидаться вперёд.', elo: 1500, skill: 10, ms: 250,
    style: 'aggressive', tolerance: 60,
    phrases: {
      start: ['Сейчас будет мясо, брат.', 'Я иду за твоим королём. Готовься.'],
      capture: ['РРР! Порвал!', 'Минус фигура, брат!', 'Тигр голоден!'],
      check: ['ШАХ, сука! Беги!', 'Король твой бегает, как курица!'],
      gloat: ['Ты сам мне это отдал, брат.', 'Слабость чую за километр.'],
      impressed: ['Уважаю. Достойный соперник.', 'Опасный ход, брат. Опасный.'],
      win: ['Тигр сожрал ещё одного.', 'Ты был ужином, брат.'],
      lose: ['Достойно. Тигр уважает силу.', 'Сегодня ты охотник. Реванш!'],
      draw: ['Ничья… Тигр недоволен.'],
    },
  },
  {
    id: 'taxi', name: 'Таксист', emoji: '🧔', about: 'Таксист, 20 лет играет во дворе. Комментирует всё.', elo: 1700, skill: 13, ms: 350,
    style: 'normal', tolerance: 30,
    phrases: {
      start: ['Садись, брат, довезу до мата. Счётчик включён.', 'Я во дворе всех обыгрывал, ты будешь следующим.'],
      capture: ['Это за проезд, брат.', 'Чаевые принимаю фигурами.'],
      check: ['Шах, брат. Пристегнись.', 'Осторожно, двери закрываются. Шах!'],
      gloat: ['Ну ты даёшь, брат. Как на светофоре заснул.', 'Такой ход даже мой пассажир бы не сделал.'],
      impressed: ['О, брат, ты шаришь!', 'Красиво поехал, уважаю.'],
      win: ['Приехали, брат. Мат. С тебя тыща.', 'Конечная, выходим!'],
      lose: ['Ладно, брат, сегодня бесплатно довёз.', 'Ты меня объехал, красава.'],
      draw: ['Пробка, брат. Ничья.'],
    },
  },
  {
    id: 'eagle', name: 'Орёл', emoji: '🦅', about: 'Давит без остановки. Сильный и злой.', elo: 2000, skill: 16, ms: 600,
    style: 'aggressive', tolerance: 35,
    phrases: {
      start: ['Отправлю тебя спать, брат.', 'Готовься, сейчас будет давление.'],
      capture: ['Забрал. Даже не заметил.', 'Это моё, брат.'],
      check: ['Шах. Отправляю тебя спать.', 'Давлю, брат. Давлю.'],
      gloat: ['Ты ошибся, брат. Я не прощаю.', 'Отправлю тебя спать прямо сейчас.'],
      impressed: ['Хороший ход. Но этого мало.', 'Уважаю, брат. Но я всё равно выиграю.'],
      win: ['Отправил спать. 29:0.', 'Без шансов, брат.'],
      lose: ['Ты сильный, брат. Уважение.', 'Сегодня твой день.'],
      draw: ['Ничья. Пойду тренироваться.'],
    },
  },
  {
    id: 'prof', name: 'Профессор', emoji: '🧠', about: 'Позиционная игра, холодный расчёт, вежливое презрение.', elo: 2300, skill: 18, ms: 900,
    style: 'solid', tolerance: 20,
    phrases: {
      start: ['Начнём урок. Постарайтесь не разочаровать.', 'Надеюсь, вы хотя бы знаете, как ходит конь.'],
      capture: ['Материал есть материал.', 'Благодарю за пожертвование. Необоснованное.'],
      check: ['Шах. Это было неизбежно.', 'Шах. Рекомендую подумать.'],
      gloat: ['Типичная ошибка третьего разряда.', 'Это зевок. Записывайте.'],
      impressed: ['Любопытно. Вы меня удивили.', 'Неожиданно точно.'],
      win: ['Урок окончен. Домашнее задание — вся теория.', 'Предсказуемо.'],
      lose: ['Признаю поражение. Это было... неожиданно.', 'Вы достойный ученик.'],
      draw: ['Ничья. Приемлемо.'],
    },
  },
  {
    id: 'machine', name: 'Машина', emoji: '🤖', about: 'Stockfish на полной силе. Без эмоций и без шансов.', elo: 2600, skill: 20, ms: 1500,
    style: 'normal', tolerance: 0,
    phrases: {
      start: ['ИНИЦИАЛИЗАЦИЯ. ВЕРОЯТНОСТЬ ВАШЕЙ ПОБЕДЫ: 0,01%.', 'ЗАГРУЖАЮ ДЕБЮТНУЮ БАЗУ. ЖДИТЕ МАТА.'],
      capture: ['МАТЕРИАЛ ПОЛУЧЕН.', 'ФИГУРА УДАЛЕНА.'],
      check: ['ШАХ. РАСЧЁТ ЗАВЕРШЁН.', 'КОРОЛЬ ПОД УГРОЗОЙ.'],
      gloat: ['ОШИБКА ОБНАРУЖЕНА. ОЦЕНКА ОБНОВЛЕНА.', 'ЧЕЛОВЕК, ВЫ СЛАБЫ.'],
      impressed: ['НЕОЖИДАННО. ПЕРЕСЧИТЫВАЮ.', 'ХОД ПРИЗНАН ТОЧНЫМ.'],
      win: ['МАТ. ЧЕЛОВЕЧЕСТВО ПРОИГРАЛО.', 'ПАРТИЯ ЗАВЕРШЕНА. ПОБЕДА МАШИНЫ.'],
      lose: ['ОШИБКА… ОШИБКА… ЭТОГО НЕ МОЖЕТ БЫТЬ.', 'ВЫ ВЗЛОМАЛИ МЕНЯ?!'],
      draw: ['НИЧЬЯ. ПРИЕМЛЕМЫЙ ИСХОД.'],
    },
  },
];

export const pickPhrase = (p: Persona, ev: BotEvent): string => {
  const list = p.phrases[ev];
  return list[Math.floor(Math.random() * list.length)];
};

/** Насколько ход подходит под стиль персонажа (больше — охотнее сыграет). */
function styleScore(style: Style, pos: Chess, uci: string): number {
  const move = parseUci(uci);
  if (!move || !('from' in move)) return 0;
  const piece = pos.board.get(move.from);
  const target = pos.board.get(move.to);
  const capture = !!target && target.color !== piece?.color;
  const castle = piece?.role === 'king' && (Math.abs((move.from & 7) - (move.to & 7)) > 1 || target?.color === piece.color);
  const after = pos.clone();
  after.play(move);
  const check = after.isCheck();
  const forward = piece?.color === 'white' ? (move.to >> 3) - (move.from >> 3) : (move.from >> 3) - (move.to >> 3);
  switch (style) {
    case 'aggressive':
      return (check ? 3 : 0) + (capture ? 2 : 0) + (forward > 0 ? 1 : 0);
    case 'solid':
      return (castle ? 3 : 0) - (capture ? 1 : 0) - (check ? 1 : 0) + (forward <= 1 ? 0.5 : 0);
    case 'troll': {
      const file = move.from & 7;
      const kingWalk = piece?.role === 'king' && !castle ? 3 : 0;
      const rimPawn = piece?.role === 'pawn' && (file === 0 || file === 7) ? 2 : 0;
      const earlyQueen = piece?.role === 'queen' && pos.fullmoves < 12 ? 2 : 0;
      const rimKnight = piece?.role === 'knight' && ((move.to & 7) === 0 || (move.to & 7) === 7) ? 1 : 0;
      return kingWalk + rimPawn + earlyQueen + rimKnight;
    }
    default:
      return 0;
  }
}

/**
 * Ход персонажа: обычно ход Stockfish на заданной силе; но если среди вариантов не хуже чем на tolerance
 * есть ход «в стиле» персонажа — с вероятностью 60% играет его. Малой играет случайный приличный ход.
 */
export function chooseMove(p: Persona, pos: Chess, bestmove: string, lines: Line[], side: Side): string {
  if (!lines.length || p.tolerance <= 0) return bestmove;
  const sign = side === 'white' ? 1 : -1;
  const top = lines[0].cp * sign;
  const ok = lines.filter((l) => l.pv[0] && top - l.cp * sign <= p.tolerance);
  if (ok.length < 2) return bestmove;
  if (p.style === 'kid') return ok[Math.floor(Math.random() * ok.length)].pv[0];
  if (p.style === 'normal' || Math.random() > 0.6) return bestmove;
  let best = bestmove;
  let bestScore = styleScore(p.style, pos, bestmove);
  for (const l of ok) {
    const s = styleScore(p.style, pos, l.pv[0]);
    if (s > bestScore) {
      best = l.pv[0];
      bestScore = s;
    }
  }
  return best;
}

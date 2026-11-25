// Экран «Игра с ботом»: партия против Stockfish с тренером — оценка хода, подсказка, угроза соперника,
// часы, сдача, ничья, выбор фигуры при превращении, звуки.
import { Chessground } from 'chessground';
import type { Key } from 'chessground/types';
import { Chess } from 'chessops/chess';
import { makeSan } from 'chessops/san';
import type { Move } from 'chessops/types';
import { parseUci } from 'chessops/util';
import type { Engine, Line } from './engine';
import {
  $, GRADE_LABEL, GRADE_MARK, boardState, cpLossFor, fenOf, gameAccuracy, moveAccuracy, fmtEval, grade, isCapture, isPromotion, posFromFen,
  repetitionKey, sanLine, sanOf, terminalLine, uciOf, userMove, winPct, winPctFor, type PromotionRole, type Side,
} from './shared';
import { pickRoast, type RoastKey } from './roast';
import { say } from './voice';
import { playSound, setSoundsEnabled } from './sounds';
import { auraPopup, fmtAura, lions, shake, sigma, wasted, zoomPunch } from './fx';
import { StreamChat, type ChatLine } from './chat';
import { auraRank, type Tone } from './memes';
import { addAura, loadStats, noteStreak, recordGame } from './stats';
import { PERSONAS, chooseMove, pickPhrase, type BotEvent } from './personas';
import { STANDARD_FEN, fen960 } from './chess960';
import { openingName } from './openings';
import { loadHistory, saveGame } from './history';
import { checkGame, unlock } from './achievements';
import type { ClipMoment } from './clip';
import { showClip } from './clipui';

const DEPTH = 12;

/** Контроль времени: минуты на партию + секунды добавки за ход. base 0 — без часов. */
const TIME_CONTROLS = [
  { name: 'Без часов', base: 0, inc: 0 },
  { name: '1 + 0 (пуля)', base: 1, inc: 0 },
  { name: '3 + 2 (блиц)', base: 3, inc: 2 },
  { name: '5 + 0 (блиц)', base: 5, inc: 0 },
  { name: '10 + 0 (рапид)', base: 10, inc: 0 },
  { name: '15 + 10 (рапид)', base: 15, inc: 10 },
];
const LOW_TIME_MS = 10_000;

/** Русское окончание: plural(1, ['зевок', 'зевка', 'зевков']) → «зевок». */
function plural(n: number, [one, few, many]: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function fmtClock(ms: number): string {
  const t = Math.max(0, ms);
  if (t < LOW_TIME_MS) return `${Math.floor(t / 1000)}.${Math.floor((t % 1000) / 100)}`;
  const s = Math.ceil(t / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface Played {
  uci: string;
  san: string;
  mark: string;
  cls: string;
  /** Потеря шансов на победу ходом игрока (п. п.); есть, только если ход оценил тренер. */
  loss?: number;
  /** Потеря в сантипешках тем же ходом. */
  cpLoss?: number;
}

/** Итог партии: winner null — ничья. */
interface Over {
  winner: Side | null;
  reason: string;
  /** Партию можно вернуть кнопкой «Ход назад» (мат, пат, сдача). На время — нельзя. */
  undoable: boolean;
}

export function initPlay(engine: Engine, openReview: (pgn: string) => void): void {
  let pos = Chess.default();
  let moves: Played[] = [];
  let history: string[] = [repetitionKey(pos)];
  let side: Side = 'white';
  let session = 0;
  let hintStage = 0;
  let over: Over | null = null;
  let drawOfferedAt = -10;
  let streak = 0;
  let recorded = false;
  let startFen = STANDARD_FEN;
  let is960 = false;
  /** Худшая оценка для игрока за партию, в пешках — для достижения «Феникс». */
  let worstEval = 0;
  /** Яркие моменты партии для клипа. */
  let moments: ClipMoment[] = [];
  /** Аура за партию: сильный ход плюс, зевок минус. */
  let aura = 0;
  const cache = new Map<string, Promise<Line | null>>();
  const wrap = $('play-board').parentElement!;

  // Часы: оставшееся время сторон, чьи сейчас идут и с какого момента.
  let tc = TIME_CONTROLS[0];
  const clock: Record<Side, number> = { white: 0, black: 0 };
  let running: Side | null = null;
  let since = 0;
  let lowWarned = false;

  const levelSel = $<HTMLSelectElement>('play-level');
  PERSONAS.forEach((p, i) => levelSel.add(new Option(`${p.emoji} ${p.name} (~${p.elo})`, String(i))));
  levelSel.value = '2';
  const persona = () => PERSONAS[Number(levelSel.value)];
  const timeSel = $<HTMLSelectElement>('play-time');
  TIME_CONTROLS.forEach((t, i) => timeSel.add(new Option(t.name, String(i))));
  timeSel.value = '4';
  const sideSel = $<HTMLSelectElement>('play-side');
  const coach = $<HTMLInputElement>('play-coach');
  const sounds = $<HTMLInputElement>('play-sounds');
  const bar = $('play-bar');
  const chat = new StreamChat($('play-chat-list'), $('play-chat-viewers'));
  const chatOn = $<HTMLInputElement>('play-chat-on');
  const toneSel = $<HTMLSelectElement>('play-tone');
  try {
    toneSel.value = localStorage.getItem('chesscoach.tone') ?? 'hard';
    chatOn.checked = localStorage.getItem('chesscoach.chat') !== 'off';
  } catch {
    /* без хранилища — по умолчанию */
  }
  if (!toneSel.value) toneSel.value = 'hard';
  const syncChat = () => {
    $('play-chat').classList.toggle('hidden', !chatOn.checked);
    chat.setEnabled(chatOn.checked);
  };
  syncChat();

  const cg = Chessground($('play-board'), {
    premovable: { enabled: false },
    movable: { free: false, events: { after: (o, d) => void onUserMove(o, d) } },
    drawable: { enabled: true },
  });

  const bot = (): Side => (side === 'white' ? 'black' : 'white');
  const coachOn = () => coach.checked;
  const myTurn = () => !over && pos.turn === side && !pos.isEnd();
  const timed = () => tc.base > 0;

  // ---------- часы ----------

  function remaining(c: Side): number {
    return running === c ? clock[c] - (performance.now() - since) : clock[c];
  }

  /** Часы стороны идут только после первого хода каждой стороны, как на Lichess. */
  function startClock(c: Side): void {
    if (!timed() || over || moves.length < 2) return;
    stopClock(false);
    running = c;
    since = performance.now();
  }

  /** Останавливает часы; addInc — добавить стороне секунды за сделанный ход. */
  function stopClock(addInc: boolean): void {
    if (running) {
      clock[running] -= performance.now() - since;
      if (addInc) clock[running] += tc.inc * 1000;
      running = null;
    }
  }

  function drawClocks(): void {
    $('play-clocks').classList.toggle('hidden', !timed());
    if (!timed()) return;
    for (const [id, c] of [['play-clock-me', side], ['play-clock-bot', bot()]] as const) {
      const el = $(id);
      const ms = remaining(c);
      el.querySelector('.time')!.textContent = fmtClock(ms);
      el.classList.toggle('running', running === c);
      el.classList.toggle('low', ms < LOW_TIME_MS);
    }
  }

  setInterval(() => {
    if (!timed()) return;
    drawClocks();
    if (!running || over) return;
    const ms = remaining(running);
    if (running === side && ms < LOW_TIME_MS && !lowWarned) {
      lowWarned = true;
      playSound('lowtime');
    }
    if (ms <= 0) {
      const loser = running;
      clock[loser] = 0;
      running = null;
      const winner = loser === 'white' ? 'black' : 'white';
      // Если у соперника нечем поставить мат — ничья, как по правилам.
      if (pos.hasInsufficientMaterial(winner)) finish(null, 'Время вышло, но у соперника не хватает фигур для мата', false);
      else finish(winner, loser === side ? 'У вас кончилось время' : 'У бота кончилось время', false, 'time');
    }
  }, 100);

  // ---------- конец партии ----------

  /** Проверка конца партии после хода. Возвращает true, если партия окончена. */
  function checkEnd(): boolean {
    if (over) return true;
    if (pos.isCheckmate()) {
      const winner: Side = pos.turn === 'white' ? 'black' : 'white';
      finish(winner, winner === side ? 'Вы поставили мат' : 'Вам поставили мат', true);
    } else if (pos.isStalemate()) finish(null, 'Пат', true);
    else if (pos.isInsufficientMaterial()) finish(null, 'Недостаточно фигур для мата', true);
    else if (history.filter((k) => k === history.at(-1)).length >= 3) finish(null, 'Троекратное повторение позиции', true);
    else if (pos.halfmoves >= 100) finish(null, 'Правило 50 ходов', true);
    return !!over;
  }

  function finish(winner: Side | null, reason: string, undoable: boolean, how: 'board' | 'time' | 'resign' = 'board'): void {
    stopClock(false);
    over = { winner, reason, undoable };
    engine.cancel();
    session++;
    playSound('end');
    const title = $('play-over-title');
    title.textContent = winner === null ? 'Ничья' : winner === side ? 'Победа!' : 'Поражение';
    title.className = `over-title ${winner === null ? '' : winner === side ? 'win' : 'loss'}`;
    $('play-over-reason').textContent = reason;
    const won = winner === side;
    const mate = pos.isCheckmate();
    // Аура за концовку.
    const endAura =
      winner === null ? 0
      : won ? (mate ? 5000 : how === 'time' ? 2000 : 3000)
      : how === 'resign' ? -2000 : how === 'time' ? -1500 : -5000;
    changeAura(endAura);
    showReport(winner, how);
    botSay(winner === null ? 'draw' : won ? 'lose' : 'win');
    // Мат — «ПОТРАЧЕНО» и грустный тромбон, окно итога после надписи.
    const s0 = session;
    const showOver = () => s0 === session && $('play-over').classList.remove('hidden');
    let chatLines: ChatLine[];
    if (won) {
      lions(wrap, 30, 'ПОБЕДА!');
      sigma(wrap, mate ? 'СИГМА' : 'ПОБЕДА');
      playSound('sigma');
      chatLines = chat.push('win');
      setTimeout(showOver, 1600);
    } else if (winner === null) {
      chatLines = chat.push('draw');
      showOver();
    } else {
      shake(wrap, true);
      if (how === 'resign') {
        chatLines = chat.push('resigned');
        showOver();
      } else {
        wasted(wrap);
        playSound('sad');
        chatLines = chat.push('mated');
        setTimeout(showOver, 2300);
      }
    }
    const tip = chat.donate(won ? 'good' : 'bad', winner === null ? 0 : 0.5);
    if (tip) chatLines.push(tip);
    const key: RoastKey =
      winner === null ? 'draw'
      : how === 'time' ? (won ? 'botFlagged' : 'flagged')
      : how === 'resign' ? 'resigned'
      : won ? 'win' : 'mated';
    const lastMove = moves.at(-1);
    roastOut(key, won ? 'best' : winner === null ? 'good' : 'blunder', {
      verdict: `${title.textContent} — ${reason.toLowerCase()}`,
      mark: lastMove && mate ? '#' : '',
      drama: winner === null ? 2 : mate ? 100 : 3, // мат — кульминация, лучший клип партии
      aura: endAura, chat: chatLines, wasted: !won && winner !== null && how !== 'resign',
    });
    render();
  }

  /** Отчёт в окне итога: точность, зевки/ошибки/неточности, звание, изменение рейтинга. */
  function showReport(winner: Side | null, how: 'board' | 'time' | 'resign'): void {
    const mine = moves.filter((m, i) => (i % 2 === 0) === (side === 'white'));
    const graded = mine.filter((m) => m.loss !== undefined);
    const report = $('play-over-report');
    const rank = $('play-over-rank');
    report.replaceChildren();
    rank.textContent = '';
    const acc = gameAccuracy(graded.map((m) => moveAccuracy(m.loss!, m.cpLoss ?? 0)));
    if (acc !== null) {
      const count = (c: string) => mine.filter((m) => m.cls === c).length;
      const [b, mi, ina] = [count('blunder'), count('mistake'), count('inaccuracy')];
      const cells: [string, string, string][] = [
        ['acc', `${Math.round(acc)}%`, 'точность'],
        ['bl', String(b), plural(b, ['зевок', 'зевка', 'зевков'])],
        ['mi', String(mi), plural(mi, ['ошибка', 'ошибки', 'ошибок'])],
        ['in', String(ina), plural(ina, ['неточность', 'неточности', 'неточностей'])],
      ];
      for (const [cls, val, label] of cells) {
        const d = document.createElement('div');
        d.className = cls;
        d.innerHTML = `<b>${val}</b><span>${label}</span>`;
        report.append(d);
      }
      if (graded.length >= 5)
        rank.textContent =
        acc >= 90 ? '🦁 Звание: Левь'
        : acc >= 75 ? '😎 Звание: Почти левь'
        : acc >= 55 ? '😐 Звание: Середнячок'
        : '🤡 Звание: Ебень дня';
    }
    const auraEl = $('play-over-aura');
    auraEl.innerHTML = `Аура за партию: <span class="${aura >= 0 ? 'up' : 'down'}">${fmtAura(aura) || '0'}</span> → ${auraRank(aura)}`;
    const ratingEl = $('play-over-rating');
    ratingEl.textContent = '';
    // Партию в один ход не считаем; повторный конец той же партии (после «Ход назад») — тоже.
    if (!recorded && mine.length >= 1) {
      recorded = true;
      addAura(aura);
      const score = winner === null ? 0.5 : winner === side ? 1 : 0;
      const { before, after } = recordGame(Number(levelSel.value), persona().elo, score, streak);
      const d = after - before;
      ratingEl.textContent = `Рейтинг: ${before} → ${after} (${d >= 0 ? '+' : '−'}${Math.abs(d)})`;
      // История и достижения.
      const count = (c: string) => mine.filter((m) => m.cls === c).length;
      const mate = pos.isCheckmate();
      const last = moves.at(-1);
      const lastTo = last ? parseUci(last.uci) : undefined;
      saveGame({
        mode: 'bot', opponent: `${persona().emoji} ${persona().name}`, myColor: side, score,
        reason: over?.reason ?? '', opening: openingLabel(), plies: moves.length,
        accuracy: acc === null ? null : Math.round(acc), chess960: is960, pgn: toPgn(),
      });
      checkGame({
        mode: 'bot', won: winner === side, lost: winner !== null && winner !== side,
        how: mate ? 'mate' : how === 'time' ? 'time' : how === 'resign' ? 'resign' : winner === null ? 'draw' : 'other',
        matingRole: mate && lastTo && 'to' in lastTo ? pos.board.get(lastTo.to)?.role : undefined,
        castleMate: mate && !!last?.san.startsWith('O-O'),
        plies: moves.length, accuracy: acc, blunders: count('blunder'), mistakes: count('mistake'),
        personaId: persona().id, worstEval, chess960: is960, gamesPlayed: loadHistory().length, rating: after,
      });
    }
    drawRecord();
  }

  /** Дебют для строки над ходами и для истории. */
  function openingLabel(): string | null {
    if (is960) return 'Шахматы 960';
    return openingName(moves.map((m) => m.san));
  }

  function drawOpening(): void {
    const name = openingLabel();
    $('play-opening').textContent = name ? `📖 ${name}` : '';
  }

  /** Реплика бота-персонажа в пузыре над панелью. */
  function botSay(ev: BotEvent, chance = 1): void {
    if (Math.random() > chance) return;
    const el = $('play-bot-say');
    el.textContent = `«${pickPhrase(persona(), ev)}»`;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  function drawBot(): void {
    const p = persona();
    $('play-bot-emoji').textContent = p.emoji;
    $('play-bot-name').textContent = p.name;
    $('play-bot-about').textContent = `~${p.elo} · ${p.about}`;
  }

  function drawRecord(): void {
    const s = loadStats();
    const lvl = Number(levelSel.value);
    const [w, d, l] = s.byLevel[lvl] ?? [0, 0, 0];
    $('play-record').innerHTML =
      `Рейтинг <b>${s.rating}</b> (пик ${s.peak}) · против: ` +
      `<b>${w}</b> ${plural(w, ['победа', 'победы', 'побед'])}, <b>${d}</b> ${plural(d, ['ничья', 'ничьи', 'ничьих'])}, ` +
      `<b>${l}</b> ${plural(l, ['поражение', 'поражения', 'поражений'])}` +
      (s.bestStreak ? ` · рекорд серии: <b>${s.bestStreak}</b>` : '');
  }

  function drawStreak(hot = false): void {
    const el = $('play-streak');
    el.textContent = streak >= 2 ? `🔥 Серия: ${streak} левь подряд` : '';
    el.classList.remove('hot');
    if (hot) {
      void el.offsetWidth;
      el.classList.add('hot');
    }
  }

  // ---------- выбор фигуры при превращении ----------

  function choosePromotion(color: Side): Promise<PromotionRole | null> {
    const box = $('play-promo');
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
      box.onclick = () => done(null); // щелчок мимо — отмена хода
      box.classList.remove('hidden');
    });
  }

  // ---------- движок ----------

  function evalFen(fen: string): Promise<Line | null> {
    const end = terminalLine(posFromFen(fen));
    if (end) return Promise.resolve(end);
    let p = cache.get(fen);
    if (!p) {
      p = engine.analyse(fen, { depth: DEPTH, chess960: is960 }).then((r) => r?.lines[0] ?? null);
      cache.set(fen, p);
      p.then((line) => {
        if (!line) cache.delete(fen);
      });
    }
    return p;
  }

  function setBar(line: Line | null): void {
    bar.style.height = `${line && coachOn() ? winPct(line.cp) : 50}%`;
    bar.parentElement!.classList.toggle('flipped', side === 'black');
    $('play-eval').textContent = line && coachOn() ? `Оценка позиции: ${fmtEval(line)} (плюс — лучше у белых)` : '';
  }

  /** Делает ход на позиции, пишет его в историю и играет звук. */
  function applyMove(move: Move): Played {
    const capture = isCapture(pos, move);
    const played: Played = { uci: uciOf(pos, move, is960), san: makeSan(pos, move), mark: '', cls: '' };
    const mover = pos.turn;
    const enPassant = capture && 'from' in move && pos.board.get(move.from)?.role === 'pawn' && !pos.board.get(move.to);
    pos.play(move);
    moves.push(played);
    history.push(repetitionKey(pos));
    if (!pos.isCheckmate()) playSound(pos.isCheck() ? 'check' : capture ? 'capture' : 'move');
    if (mover === side) {
      if (enPassant) unlock('en_passant');
      if ('promotion' in move && move.promotion && move.promotion !== 'queen') unlock('underpromote');
    }
    drawOpening();
    return played;
  }

  function statusText(): string {
    if (over) {
      const res = over.winner === null ? 'Ничья' : over.winner === side ? 'Вы победили' : 'Вы проиграли';
      return `${res}: ${over.reason.toLowerCase()}`;
    }
    return myTurn() ? (pos.isCheck() ? 'Ваш ход — вам шах!' : 'Ваш ход') : 'Бот думает…';
  }

  function render(): void {
    cg.set({ ...boardState(pos, myTurn() ? side : null, moves.at(-1)?.uci, is960), orientation: side });
    cg.setAutoShapes([]);
    hintStage = 0;
    $('play-hint-text').textContent = '';
    const list = $('play-moves');
    list.replaceChildren();
    for (let i = 0; i < moves.length; i += 2) {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = `${i / 2 + 1}.`;
      list.append(num);
      for (const m of [moves[i], moves[i + 1]]) {
        const el = document.createElement('span');
        el.className = `mv ${m?.cls ?? ''}`;
        el.textContent = m ? m.san + m.mark : '';
        list.append(el);
      }
    }
    list.scrollTop = list.scrollHeight;
    $('play-status').textContent = statusText();
    for (const id of ['play-hint', 'play-threat']) $<HTMLButtonElement>(id).disabled = !myTurn() || !coachOn();
    $<HTMLButtonElement>('play-undo').disabled = moves.length === 0 || (!!over && !over.undoable);
    $<HTMLButtonElement>('play-review').disabled = moves.length < 2;
    $<HTMLButtonElement>('play-resign').disabled = !!over || moves.length < 1;
    $<HTMLButtonElement>('play-draw').disabled = !myTurn() || moves.length < 2 || moves.length - drawOfferedAt < 10;
    drawClocks();
  }

  function changeAura(delta: number, note?: string): void {
    if (!delta) return;
    aura += delta;
    auraPopup(wrap, delta, note);
    drawAura();
  }

  function drawAura(): void {
    const el = $('play-aura');
    el.textContent = `Аура: ${fmtAura(aura) || '0'}`;
    el.className = `aura ${aura > 0 ? 'up' : aura < 0 ? 'down' : ''}`;
  }

  function drawClipBtn(): void {
    const n = moments.length;
    for (const id of ['play-clip', 'play-over-clip']) $<HTMLButtonElement>(id).disabled = n === 0;
  }

  /** Лучший момент партии — самый яркий; при равенстве — поздний. */
  function bestMoment(): ClipMoment | undefined {
    return moments.reduce<ClipMoment | undefined>((b, m) => (!b || m.drama >= b.drama ? m : b), undefined);
  }

  /** Реплика тренера «без цензуры» над разбором хода (и голосом, если включён). cls — цвет. */
  function roastOut(
    key: RoastKey,
    cls: string,
    clip?: { verdict: string; mark: string; drama: number; aura?: number; chat?: ChatLine[]; wasted?: boolean },
  ): void {
    const tone = toneSel.value as Tone | 'off';
    const phrase = tone === 'off' ? null : pickRoast(key, tone);
    if (clip && moves.length) {
      moments = moments.filter((m) => m.ucis.length !== moves.length);
      moments.push({
        startFen, ucis: moves.map((m) => m.uci), orientation: side, phrase, cls,
        title: `Я vs ${persona().emoji} ${persona().name}`, ...clip,
      });
      drawClipBtn();
    }
    if (!phrase) return;
    const fb = $('play-feedback');
    const old = fb.querySelector('.roast');
    if (old) {
      if (old.nextElementSibling?.tagName === 'BR') old.nextElementSibling.remove();
      old.remove();
    }
    const b = document.createElement('b');
    b.className = `${cls} roast`;
    b.textContent = phrase;
    fb.prepend(b, document.createElement('br'));
    if ($<HTMLInputElement>('play-voice').checked) say(phrase);
  }

  async function next(): Promise<void> {
    const s = session;
    if (over || checkEnd()) return;
    if (pos.turn !== side) {
      const p = persona();
      // В цейтноте бот тоже думает быстрее: не больше 1/30 оставшегося времени.
      const ms = timed() ? Math.max(30, Math.min(p.ms, remaining(bot()) / 30)) : p.ms;
      startClock(bot());
      const res = await engine.analyse(fenOf(pos), {
        movetime: ms, skill: p.skill, multipv: p.tolerance > 0 ? 4 : 1, chess960: is960,
      });
      if (s !== session || !res || over) return;
      // Ход «в стиле» персонажа (агрессия, осторожность, троллинг), если он не сильно хуже лучшего.
      let uci = chooseMove(p, pos, res.bestmove, res.lines, bot());
      if (!parseUci(uci) || !pos.isLegal(parseUci(uci)!)) uci = res.bestmove;
      const move = parseUci(uci);
      if (!move || !pos.isLegal(move)) return;
      stopClock(true);
      const captured = isCapture(pos, move);
      applyMove(move);
      if (!pos.isEnd()) {
        if (pos.isCheck()) {
          botSay('check', 0.6);
          chat.push('check', 0.8);
        } else if (captured) {
          botSay('capture', 0.4);
          chat.push('botCapture', 0.6);
        } else chat.push('move', 0.3);
      }
      render();
      if (checkEnd()) return;
      startClock(side);
      render();
    } else {
      startClock(side);
    }
    if (coachOn()) {
      const line = await evalFen(fenOf(pos));
      if (s === session) setBar(line);
    }
  }

  async function onUserMove(orig: Key, dest: Key): Promise<void> {
    if (!myTurn()) return render();
    let promotion: PromotionRole = 'queen';
    if (isPromotion(pos, orig, dest)) {
      const s0 = session;
      const choice = await choosePromotion(side);
      if (!choice || s0 !== session || !myTurn()) return render();
      promotion = choice;
    }
    const move = userMove(pos, orig, dest, promotion);
    if (!move) return render();
    const s = session;
    const fenBefore = fenOf(pos);
    stopClock(true);
    const played = applyMove(move);
    render();
    $('play-feedback').textContent = '';
    if (coachOn()) {
      const [before, after] = await Promise.all([evalFen(fenBefore), evalFen(fenOf(pos))]);
      if (s !== session) return;
      if (before && after) {
        const loss = Math.max(0, winPctFor(before.cp, side) - winPctFor(after.cp, side));
        const cpLoss = cpLossFor(before.cp, after.cp, side);
        const g = grade(loss, before.pv[0] === played.uci, cpLoss);
        played.mark = GRADE_MARK[g];
        played.cls = g;
        played.loss = loss;
        played.cpLoss = cpLoss;
        worstEval = Math.min(worstEval, (side === 'white' ? after.cp : -after.cp) / 100);
        if (!pos.isEnd()) {
          if (g === 'blunder') botSay('gloat');
          else if (g === 'mistake') botSay('gloat', 0.5);
          else if (g === 'best') botSay('impressed', 0.3);
        }
        let html = `<b class="${g}">${played.san}${played.mark} — ${GRADE_LABEL[g].toLowerCase()}.</b>`;
        if (g !== 'best' && g !== 'good' && before.pv[0]) {
          html += ` Сильнее было ${sanOf(fenBefore, before.pv[0])} (оценка ${fmtEval(before)}), после вашего хода — ${fmtEval(after)}.`;
        }
        $('play-feedback').innerHTML = html;
        // Не хвалим, если хвалить не за что: ход был единственный или позиция уже проиграна.
        // Если ход закончил партию, реплику скажет finish().
        const legalCount = [...posFromFen(fenBefore).allDests().values()].reduce((n, set) => n + set.size(), 0);
        const good = g === 'best' || g === 'good';
        // Серия: сильные ходы подряд. Единственный ход серию не двигает.
        let milestone: RoastKey | null = null;
        if (legalCount > 1) {
          if (good) {
            streak++;
            noteStreak(streak);
            if (streak >= 5) unlock('streak5');
            if (streak >= 10) unlock('streak10');
            if (streak === 3) milestone = 'streak3';
            else if (streak === 5) milestone = 'streak5';
            else if (streak >= 8 && streak % 4 === 0) milestone = 'streak8';
          } else {
            if (streak >= 3) milestone = 'streakBroken';
            streak = 0;
          }
        }
        drawStreak(!!milestone && milestone !== 'streakBroken');
        // Эффекты над доской: тряска, наезд камеры, львы.
        if (g === 'blunder') {
          shake(wrap, true);
          const to = played.uci.slice(2, 4);
          const fx = (to.charCodeAt(0) - 97 + 0.5) / 8;
          const fy = (8 - Number(to[1]) + 0.5) / 8;
          zoomPunch(wrap, side === 'white' ? fx : 1 - fx, side === 'white' ? fy : 1 - fy);
          playSound('boom');
        } else if (g === 'mistake') {
          shake(wrap, false);
          playSound('womp');
        }
        const hot = !!milestone && milestone !== 'streakBroken';
        if (hot) {
          lions(wrap, 28, `ЛЕВЬ ×${streak}`);
          playSound('sigma');
        } else if (g === 'best' && legalCount > 1) lions(wrap, 7);
        // Аура: единственный ход и «хороший ход в проигранной» не считаются; в серии — вдвое.
        const AURA: Record<string, number> = { best: 1000, good: 300, inaccuracy: -200, mistake: -500, blunder: -1000 };
        const myCp = side === 'white' ? before.cp : -before.cp;
        let delta = legalCount === 1 || (good && myCp <= -600) ? 0 : AURA[g];
        if (good && streak >= 3) delta *= 2;
        if (!pos.isEnd()) changeAura(delta, hot ? `серия ×${streak}` : undefined);
        // Чат: зевок — ржут, сильный ход — «сигма».
        let chatLines: ChatLine[] = [];
        if (!pos.isEnd()) {
          chatLines = chat.push(hot ? 'streak' : g, g === 'good' ? 0.5 : 1);
          const tip = g === 'blunder' ? chat.donate('bad', 0.2) : g === 'best' || hot ? chat.donate('good', 0.12) : null;
          if (tip) chatLines.push(tip);
        }
        if (!pos.isEnd()) {
          let key: RoastKey = g;
          const myCpBefore = side === 'white' ? before.cp : -before.cp;
          if (legalCount === 1) key = 'forced';
          else if (milestone) key = milestone;
          else if (good && myCpBefore <= -600) key = 'doomed';
          const drama =
            g === 'blunder' ? 5 + loss / 20
            : g === 'mistake' ? 3
            : milestone && milestone !== 'streakBroken' ? 3.5 + streak / 10
            : g === 'best' ? 2
            : 1;
          roastOut(key, g, {
            verdict: `${played.san}${played.mark} — ${GRADE_LABEL[g].toLowerCase()}`,
            mark: g === 'best' ? '!' : played.mark, drama, aura: delta, chat: chatLines,
          });
        }
        setBar(after);
        render();
      }
    }
    if (s !== session) return;
    void next();
  }

  function restart(): void {
    engine.cancel();
    cache.clear();
    session++;
    $('play-promo').classList.add('hidden');
  }

  function rebuild(): void {
    pos = posFromFen(startFen);
    history = [repetitionKey(pos)];
    for (const m of moves) {
      pos.play(parseUci(m.uci)!);
      history.push(repetitionKey(pos));
    }
  }

  function newGame(): void {
    restart();
    side = sideSel.value as Side;
    tc = TIME_CONTROLS[Number(timeSel.value)];
    clock.white = clock.black = tc.base * 60_000;
    running = null;
    lowWarned = false;
    over = null;
    drawOfferedAt = -10;
    streak = 0;
    recorded = false;
    worstEval = 0;
    moments = [];
    drawClipBtn();
    aura = 0;
    drawAura();
    chat.reset();
    wrap.classList.remove('fx-wasted');
    is960 = $<HTMLInputElement>('play-960').checked;
    startFen = is960 ? fen960() : STANDARD_FEN;
    drawStreak();
    drawRecord();
    drawBot();
    moves = [];
    rebuild();
    $('play-over').classList.add('hidden');
    $('play-feedback').textContent = '';
    drawOpening();
    botSay('start');
    chat.push('start');
    setBar(null);
    render();
    void next();
  }

  function undo(): void {
    if (over && !over.undoable) return;
    restart();
    stopClock(false);
    over = null;
    $('play-over').classList.add('hidden');
    moves.pop();
    if (moves.length % 2 !== (side === 'white' ? 0 : 1)) moves.pop();
    streak = 0; // взял ход назад — серия не считается
    drawStreak();
    changeAura(-300, 'ход назад');
    chat.push('mistake', 0.7);
    rebuild();
    moments = moments.filter((m) => m.ucis.length <= moves.length);
    drawClipBtn();
    $('play-feedback').textContent = '';
    render();
    void next();
  }

  function resign(): void {
    if (over || !confirm('Сдаться? Партия будет засчитана как поражение.')) return;
    restart();
    finish(bot(), 'Вы сдались', true, 'resign');
  }

  /** Бот соглашается на ничью, если ему хуже или позиция равная и партия уже длинная. */
  async function offerDraw(): Promise<void> {
    if (!myTurn()) return;
    const s = session;
    drawOfferedAt = moves.length;
    render();
    const out = $('play-hint-text');
    out.textContent = 'Бот думает над предложением ничьей…';
    const line = await evalFen(fenOf(pos));
    if (s !== session || over) return;
    const botCp = line ? (bot() === 'white' ? line.cp : -line.cp) : 0;
    const accept = botCp <= -150 || (Math.abs(botCp) <= 40 && moves.length >= 40);
    if (accept) {
      out.textContent = '';
      finish(null, 'Ничья по соглашению', true);
    } else {
      playSound('notify');
      out.textContent =
        botCp > 40
          ? 'Бот отказался: у него позиция лучше. Предложить снова можно через 5 ходов.'
          : 'Бот отказался: играем дальше. Предложить снова можно через 5 ходов.';
    }
  }

  async function hint(): Promise<void> {
    const s = session;
    const fen = fenOf(pos);
    const line = await evalFen(fen);
    if (s !== session || !line?.pv[0]) return;
    const best = line.pv[0];
    hintStage = Math.min(hintStage + 1, 2);
    if (hintStage === 1) {
      cg.setAutoShapes([{ orig: best.slice(0, 2) as Key, brush: 'green' }]);
      $('play-hint-text').textContent = 'Присмотритесь к этой фигуре. Нажмите «Подсказка» ещё раз — покажу ход.';
    } else {
      cg.setAutoShapes([{ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: 'green' }]);
      $('play-hint-text').textContent = `Лучший ход: ${sanOf(fen, best)}. Продолжение: ${sanLine(fen, line.pv)}.`;
    }
  }

  async function threat(): Promise<void> {
    const s = session;
    const out = $('play-hint-text');
    if (pos.isCheck()) {
      out.textContent = 'Вам шах — сначала нужно его отразить.';
      return;
    }
    // «Пропускаем» свой ход и смотрим, что сыграет соперник.
    const parts = fenOf(pos).split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    parts[3] = '-';
    const fen = parts.join(' ');
    const res = await engine.analyse(fen, { depth: DEPTH, chess960: is960 });
    const line = res?.lines[0];
    if (s !== session || !line?.pv[0]) return;
    const m = line.pv[0];
    cg.setAutoShapes([{ orig: m.slice(0, 2) as Key, dest: m.slice(2, 4) as Key, brush: 'red' }]);
    out.textContent = `Если ничего не предпринять, соперник сыграет ${sanOf(fen, m)} (оценка станет ${fmtEval(line)}).`;
  }

  function toPgn(): string {
    const result = !over ? '*' : over.winner === null ? '1/2-1/2' : over.winner === 'white' ? '1-0' : '0-1';
    const body = moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m.san}` : m.san)).join(' ');
    const botName = persona().name;
    const [white, black] = side === 'white' ? ['Я', botName] : [botName, 'Я'];
    const tcTag = timed() ? `[TimeControl "${tc.base * 60}+${tc.inc}"]\n` : '';
    const term = over ? `[Termination "${over.reason}"]\n` : '';
    const v960 = is960 ? `[Variant "Chess960"]\n[SetUp "1"]\n[FEN "${startFen}"]\n` : '';
    return `[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n${v960}${tcTag}${term}\n${body} ${result}\n`;
  }

  $('play-new').onclick = newGame;
  $('play-undo').onclick = undo;
  $('play-resign').onclick = resign;
  $('play-draw').onclick = () => void offerDraw();
  $('play-hint').onclick = () => void hint();
  $('play-threat').onclick = () => void threat();
  $('play-review').onclick = () => openReview(toPgn());
  $('play-over-new').onclick = newGame;
  $('play-over-review').onclick = () => openReview(toPgn());
  $('play-clip').onclick = () => {
    const m = moments.at(-1);
    if (m) void showClip(m);
  };
  $('play-over-clip').onclick = () => {
    const m = bestMoment();
    if (m) void showClip(m);
  };
  $('play-over-close').onclick = () => $('play-over').classList.add('hidden');
  sounds.onchange = () => setSoundsEnabled(sounds.checked);
  const store = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* не сохранилось — не страшно */
    }
  };
  toneSel.onchange = () => store('chesscoach.tone', toneSel.value);
  chatOn.onchange = () => {
    store('chesscoach.chat', chatOn.checked ? 'on' : 'off');
    syncChat();
  };
  levelSel.onchange = () => {
    drawRecord();
    drawBot();
    $('play-bot-say').textContent = `«${pickPhrase(persona(), 'start')}»`;
  };
  coach.onchange = () => {
    setBar(null);
    render();
    void next();
  };
  newGame();
}

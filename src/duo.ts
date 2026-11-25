// Экран «Два игрока»: партия двух людей — за одним компьютером или по сети (через electron/net.cjs).
// Правила проверяет каждая сторона сама; по сети ходят только события: ход, сдача, ничья, реванш, флажок.
import { Chessground } from 'chessground';
import type { Key } from 'chessground/types';
import { Chess } from 'chessops/chess';
import { makeSan } from 'chessops/san';
import type { Move } from 'chessops/types';
import { parseUci } from 'chessops/util';
import {
  $, boardState, fenOf, isCapture, isPromotion, posFromFen, repetitionKey, uciOf, userMove, type PromotionRole, type Side,
} from './shared';
import { LOW_TIME_MS, TIME_CONTROLS, choosePromotion, fmtClock, renderMoveList, type TimeControl } from './ui';
import { playSound, setSoundsEnabled } from './sounds';
import { lions, shake } from './fx';
import { DuoCoach } from './duocoach';
import { showClip } from './clipui';
import { STANDARD_FEN, fen960, isStandardFen } from './chess960';
import { openingName } from './openings';
import { loadHistory, saveGame } from './history';
import { checkGame, unlock } from './achievements';

interface NetEvent {
  seq: number;
  from: 'host' | 'guest';
  type: string;
  data: any;
}

declare global {
  interface Window {
    coachNet?: {
      host(opts: { hostColor: Side; tc: TimeControl; name: string; startFen: string }): Promise<{ ok: boolean; error?: string; addresses?: string[]; port?: number }>;
      join(addr: string, name: string): Promise<{ ok: boolean; error?: string; hostColor?: Side; tc?: TimeControl; hostName?: string; startFen?: string | null }>;
      send(type: string, data?: unknown): Promise<{ ok: boolean }>;
      update(opts: { hostColor?: Side; startFen?: string }): Promise<void>;
      leave(): Promise<void>;
      onEvent(cb: (ev: NetEvent) => void): void;
      onStatus(cb: (st: { connected: boolean; reason?: string }) => void): void;
    };
  }
}

const other = (c: Side): Side => (c === 'white' ? 'black' : 'white');
const COLOR_NAME: Record<Side, string> = { white: 'Белые', black: 'Чёрные' };

export function initDuo(openReview: (pgn: string) => void): void {
  const net = window.coachNet;
  let mode: 'local' | 'net' = 'local';

  // Партия.
  let pos = Chess.default();
  let ucis: string[] = [];
  let sans: string[] = [];
  let history: string[] = [];
  let over: { winner: Side | null; reason: string } | null = null;
  let started = false;
  let orientation: Side = 'white';
  const names: Record<Side, string> = { white: 'Белые', black: 'Чёрные' };
  let startFen = STANDARD_FEN;
  let is960 = false;
  let recorded = false;
  /** Расстановка для реванша, которую мы предложили (по сети её выбирает предложивший). */
  let myRematchFen = STANDARD_FEN;

  // Сеть.
  let role: 'host' | 'guest' | null = null;
  let connected = false;
  let myColor: Side = 'white';
  let hostColor: Side = 'white';
  let offer: 'draw' | 'rematch' | null = null; // предложение соперника, ждёт ответа
  let myDrawAt = -10;
  let myRematchSent = false;

  // Часы.
  let tc: TimeControl = TIME_CONTROLS[0];
  const clock: Record<Side, number> = { white: 0, black: 0 };
  let running: Side | null = null;
  let since = 0;
  let lowWarned = false;

  const timeSel = $<HTMLSelectElement>('duo-time');
  TIME_CONTROLS.forEach((t, i) => timeSel.add(new Option(t.name, String(i))));
  timeSel.value = '4';
  const modeSel = $<HTMLSelectElement>('duo-mode');
  // В браузере игры по сети пока нет: связь идёт через приложение для компьютера.
  if (!net) {
    const opt = [...modeSel.options].find((o) => o.value === 'net');
    if (opt) {
      opt.disabled = true;
      opt.textContent += ' — только в приложении';
    }
  }
  const autoflip = $<HTMLInputElement>('duo-autoflip');
  const sounds = $<HTMLInputElement>('duo-sounds');
  const wrap = $('duo-board').parentElement!;
  const nameInput = $<HTMLInputElement>('duo-name');
  try {
    nameInput.value = localStorage.getItem('chesscoach.name') ?? '';
  } catch {
    /* без сохранения имени */
  }

  const cg = Chessground($('duo-board'), {
    premovable: { enabled: false },
    movable: { free: false, events: { after: (o, d) => void onBoardMove(o, d) } },
    drawable: { enabled: true },
  });

  const coach = new DuoCoach(wrap, {
    names,
    me: () => (mode === 'net' ? myColor : null),
    startFen: () => startFen,
    ucis: () => ucis,
    is960: () => is960,
    orientation: () => orientation,
  }, () => {
    $<HTMLButtonElement>('duo-clip').disabled = !coach.hasMoments();
  });

  const timed = () => tc.base > 0;
  const myName = () => nameInput.value.trim().slice(0, 20) || 'Игрок';
  const canMove = () =>
    !over && started && (mode === 'local' || (connected && pos.turn === myColor));

  // ---------- часы ----------

  const remaining = (c: Side) => (running === c ? clock[c] - (performance.now() - since) : clock[c]);

  function startClock(c: Side): void {
    if (!timed() || over || !started || ucis.length < 2) return;
    stopClock(false);
    running = c;
    since = performance.now();
  }

  function stopClock(addInc: boolean): void {
    if (!running) return;
    clock[running] -= performance.now() - since;
    if (addInc) clock[running] += tc.inc * 1000;
    running = null;
  }

  function drawClocks(): void {
    $('duo-clocks').classList.toggle('hidden', !timed());
    if (!timed()) return;
    for (const c of ['white', 'black'] as const) {
      const el = $(`duo-clock-${c}`);
      const ms = remaining(c);
      el.querySelector('.who')!.textContent = names[c] + (mode === 'net' && c === myColor ? ' (вы)' : '');
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
    const mine = mode === 'local' || running === myColor;
    if (mine && ms < LOW_TIME_MS && !lowWarned) {
      lowWarned = true;
      playSound('lowtime');
    }
    if (ms > 0) return;
    const loser = running;
    if (mode === 'net' && loser !== myColor) return; // флажок соперника он пришлёт сам
    clock[loser] = 0;
    running = null;
    const winner = other(loser);
    if (mode === 'net') void net?.send('flag');
    if (pos.hasInsufficientMaterial(winner)) finish(null, 'Время вышло, но у соперника не хватает фигур для мата', 'draw');
    else finish(winner, mode === 'net' ? 'У вас кончилось время' : `У ${loser === 'white' ? 'белых' : 'чёрных'} кончилось время`, 'time');
  }, 100);

  // ---------- партия ----------

  /** Новая партия с расстановки fen (обычной или 960). */
  function startGame(fen = startFen): void {
    startFen = fen;
    is960 = !isStandardFen(fen);
    recorded = false;
    pos = posFromFen(startFen);
    ucis = [];
    sans = [];
    history = [repetitionKey(pos)];
    over = null;
    started = true;
    offer = null;
    myDrawAt = -10;
    myRematchSent = false;
    clock.white = clock.black = tc.base * 60_000;
    running = null;
    lowWarned = false;
    orientation = mode === 'net' ? myColor : 'white';
    coach.newGame();
    $('duo-over').classList.add('hidden');
    $('duo-promo').classList.add('hidden');
    playSound('notify');
    render();
  }

  /** Ход на доске. remoteClock — время соперника после его хода (по сети). */
  function doMove(move: Move, remoteClock?: number): void {
    const mover = pos.turn;
    if (timed()) {
      if (remoteClock !== undefined) {
        running = null;
        clock[mover] = remoteClock;
      } else stopClock(true);
    }
    const capture = isCapture(pos, move);
    // Достижения за особые ходы — только свои (по сети) или любые (за одним компьютером).
    if (mode === 'local' || mover === myColor) {
      if (capture && 'from' in move && pos.board.get(move.from)?.role === 'pawn' && !pos.board.get(move.to)) unlock('en_passant');
      if ('promotion' in move && move.promotion && move.promotion !== 'queen') unlock('underpromote');
    }
    const fenBefore = fenOf(pos);
    const san = makeSan(pos, move);
    const uci = uciOf(pos, move, is960);
    sans.push(san);
    ucis.push(uci);
    pos.play(move);
    history.push(repetitionKey(pos));
    void coach.onMove({
      fenBefore, fenAfter: fenOf(pos), uci, san, mover, ply: ucis.length, capture,
      check: pos.isCheck(), end: pos.isEnd(),
    });
    if (!pos.isCheckmate()) playSound(pos.isCheck() ? 'check' : capture ? 'capture' : 'move');
    if (offer === 'draw') offer = null; // ход вместо ответа — отказ
    if (!checkEnd()) startClock(pos.turn);
    if (mode === 'local' && autoflip.checked && !over) orientation = pos.turn;
    render();
  }

  function checkEnd(): boolean {
    if (over) return true;
    if (pos.isCheckmate()) {
      const winner = other(pos.turn);
      finish(winner, mode === 'net' ? (winner === myColor ? 'Вы поставили мат' : 'Вам поставили мат') : `Мат. ${COLOR_NAME[winner]} победили`, 'mate');
    } else if (pos.isStalemate()) finish(null, 'Пат', 'draw');
    else if (pos.isInsufficientMaterial()) finish(null, 'Недостаточно фигур для мата', 'draw');
    else if (history.filter((k) => k === history.at(-1)).length >= 3) finish(null, 'Троекратное повторение позиции', 'draw');
    else if (pos.halfmoves >= 100) finish(null, 'Правило 50 ходов', 'draw');
    return !!over;
  }

  /** История и достижения — один раз за партию. */
  function recordFinished(winner: Side | null, how: 'mate' | 'time' | 'resign' | 'draw'): void {
    if (recorded || ucis.length < 2) return;
    recorded = true;
    const net_ = mode === 'net';
    const score: 0 | 0.5 | 1 = winner === null ? 0.5 : (net_ ? winner === myColor : winner === 'white') ? 1 : 0;
    saveGame({
      mode: net_ ? 'net' : 'local',
      opponent: net_ ? `🌐 ${names[other(myColor)]}` : '🛋️ Друг за компьютером',
      myColor: net_ ? myColor : null, score, reason: over?.reason ?? '', opening: openingLabel(),
      plies: ucis.length, accuracy: null, chess960: is960, pgn: toPgn(),
    });
    const last = parseUci(ucis.at(-1) ?? '');
    checkGame({
      mode: net_ ? 'net' : 'local',
      won: net_ && winner === myColor, lost: net_ && winner !== null && winner !== myColor, how,
      matingRole: how === 'mate' && last && 'to' in last ? pos.board.get(last.to)?.role : undefined,
      castleMate: how === 'mate' && !!sans.at(-1)?.startsWith('O-O'),
      plies: ucis.length, accuracy: null, blunders: 0, mistakes: 0, chess960: is960, gamesPlayed: loadHistory().length,
    });
  }

  function openingLabel(): string | null {
    return is960 ? 'Шахматы 960' : openingName(sans);
  }

  function finish(winner: Side | null, reason: string, how: 'mate' | 'time' | 'resign' | 'draw'): void {
    if (over) return;
    stopClock(false);
    over = { winner, reason };
    offer = null;
    playSound('end');
    const title = $('duo-over-title');
    if (mode === 'net') {
      title.textContent = winner === null ? 'Ничья' : winner === myColor ? 'Победа!' : 'Поражение';
      title.className = `over-title ${winner === null ? '' : winner === myColor ? 'win' : 'loss'}`;
      if (winner === myColor) lions(wrap, 30, 'ПОБЕДА!');
      else if (winner) shake(wrap, true);
    } else {
      title.textContent = winner === null ? 'Ничья' : `Победили ${winner === 'white' ? 'белые' : 'чёрные'}`;
      title.className = 'over-title win';
      if (winner) lions(wrap, 30, `${names[winner].toUpperCase()}!`);
    }
    $('duo-over-reason').textContent = reason;
    $('duo-over-again').textContent = mode === 'net' ? 'Реванш' : 'Новая партия';
    // Комментатор: аура за концовку, «ПОТРАЧЕНО» или моаи; окно итога — когда эффект отыграл.
    const delay = coach.end(winner, how, title.textContent ?? '', reason);
    $('duo-over-aura').textContent = coach.auraSummary();
    const shown = over;
    setTimeout(() => {
      if (over === shown) $('duo-over').classList.remove('hidden');
    }, delay);
    recordFinished(winner, how);
    render();
  }

  async function onBoardMove(orig: Key, dest: Key): Promise<void> {
    if (!canMove()) return render();
    let promotion: PromotionRole = 'queen';
    if (isPromotion(pos, orig, dest)) {
      const before = ucis.length;
      const choice = await choosePromotion($('duo-promo'), pos.turn);
      if (!choice || before !== ucis.length || !canMove()) return render();
      promotion = choice;
    }
    const move = userMove(pos, orig, dest, promotion);
    if (!move) return render();
    const uci = uciOf(pos, move, is960);
    const mover = pos.turn;
    doMove(move);
    if (mode === 'net') {
      const res = await net?.send('move', { uci, clock: timed() ? Math.round(clock[mover]) : null });
      if (!res?.ok) setNetStatus('Ход не дошёл до соперника — проверьте связь', 'bad');
    }
  }

  // ---------- экран ----------

  function statusText(): string {
    if (over) return `${$('duo-over-title').textContent}: ${over.reason.toLowerCase()}`;
    if (!started) {
      if (mode === 'local') return 'Нажмите «Новая партия»';
      return role === 'host' ? 'Ждём, пока соперник подключится…' : 'Создайте игру или подключитесь к другу';
    }
    const check = pos.isCheck() ? ' — шах!' : '';
    if (mode === 'local') return `Ход ${pos.turn === 'white' ? 'белых' : 'чёрных'}${check}`;
    if (!connected) return 'Соперник не на связи';
    return pos.turn === myColor ? `Ваш ход${check}` : `Ход соперника (${names[pos.turn]})${check}`;
  }

  function render(): void {
    const movable: Side | null = canMove() ? pos.turn : null;
    cg.set({ ...boardState(pos, movable, ucis.at(-1), is960), orientation });
    renderMoveList($('duo-moves'), sans);
    const op = started ? openingLabel() : null;
    $('duo-opening').textContent = op ? `📖 ${op}` : '';
    $('duo-status').textContent = statusText();
    const net_ = mode === 'net';
    const active = started && !over && (!net_ || connected);
    $<HTMLButtonElement>('duo-undo').classList.toggle('hidden', net_);
    $<HTMLButtonElement>('duo-undo').disabled = !started || ucis.length === 0;
    $<HTMLButtonElement>('duo-resign').disabled = !active || ucis.length < 1;
    $<HTMLButtonElement>('duo-draw').disabled = !active || ucis.length < 2 || (net_ && ucis.length - myDrawAt < 10);
    $<HTMLButtonElement>('duo-review').disabled = ucis.length < 2;
    // Предложение соперника.
    const box = $('duo-offer');
    box.classList.toggle('hidden', !offer);
    $('duo-offer-text').textContent =
      offer === 'draw' ? 'Соперник предлагает ничью' : offer === 'rematch' ? 'Соперник предлагает реванш' : '';
    drawClocks();
  }

  function setNetStatus(text: string, kind: '' | 'ok' | 'bad' = ''): void {
    const el = $('duo-net-status');
    el.textContent = text;
    el.className = `net-status ${kind}`;
  }

  function showNetControls(): void {
    const inGame = role !== null;
    for (const id of ['duo-host', 'duo-join', 'duo-addr', 'duo-color', 'duo-name']) {
      ($(id) as HTMLInputElement).disabled = inGame;
    }
    timeSel.disabled = mode === 'net' && inGame;
    $('duo-leave').classList.toggle('hidden', !inGame);
    if (!inGame) $('duo-code').classList.add('hidden');
  }

  function setMode(m: 'local' | 'net'): void {
    if (mode === 'net' && m !== 'net' && role) void leave();
    mode = m;
    modeSel.value = m;
    $('duo-local').classList.toggle('hidden', m !== 'local');
    $('duo-net').classList.toggle('hidden', m !== 'net');
    started = false;
    over = null;
    $('duo-over').classList.add('hidden');
    pos = Chess.default();
    ucis = [];
    sans = [];
    running = null;
    names.white = 'Белые';
    names.black = 'Чёрные';
    if (m === 'net' && !net) setNetStatus('Игра по сети работает только в приложении Chess Coach, не в браузере.', 'bad');
    showNetControls();
    if (m === 'local') {
      tc = TIME_CONTROLS[Number(timeSel.value)];
      startGame(newFen());
    } else render();
  }

  /** Расстановка для новой партии: обычная или случайная 960 — по галочке. */
  const newFen = () => ($<HTMLInputElement>('duo-960').checked ? fen960() : STANDARD_FEN);

  // ---------- локальная игра ----------

  function newLocalGame(): void {
    tc = TIME_CONTROLS[Number(timeSel.value)];
    names.white = 'Белые';
    names.black = 'Чёрные';
    startGame(newFen());
  }

  function undoLocal(): void {
    if (mode !== 'local' || !ucis.length) return;
    stopClock(false);
    ucis.pop();
    sans.pop();
    pos = posFromFen(startFen);
    history = [repetitionKey(pos)];
    for (const u of ucis) {
      pos.play(parseUci(u)!);
      history.push(repetitionKey(pos));
    }
    over = null;
    $('duo-over').classList.add('hidden');
    coach.undo(pos.turn);
    if (autoflip.checked) orientation = pos.turn;
    startClock(pos.turn);
    render();
  }

  // ---------- сеть ----------

  async function host(): Promise<void> {
    if (!net) return;
    const pick = ($<HTMLSelectElement>('duo-color').value as Side | 'random');
    hostColor = pick === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : pick;
    tc = TIME_CONTROLS[Number(timeSel.value)];
    saveName();
    setNetStatus('Создаю игру…');
    startFen = newFen();
    is960 = !isStandardFen(startFen);
    const r = await net.host({ hostColor, tc, name: myName(), startFen });
    if (!r.ok) {
      setNetStatus(r.error ?? 'Не удалось создать игру', 'bad');
      return;
    }
    role = 'host';
    myColor = hostColor;
    connected = false;
    started = false;
    names[myColor] = myName();
    names[other(myColor)] = 'Соперник';
    const addrs = r.addresses ?? [];
    const code = $('duo-code');
    code.innerHTML = addrs.length
      ? `Код для друга: ${addrs.map((a) => `<b>${a}</b>`).join(' или ')}` +
        `<small>Друг выбирает «По сети», вводит код и жмёт «Подключиться». Вы оба должны быть в одной сети (Wi-Fi). ` +
        `Если Windows спросит про брандмауэр — разрешите доступ в частных сетях.</small>`
      : 'Компьютер не подключён к сети — другу не к чему подключиться.';
    code.classList.remove('hidden');
    setNetStatus(`Вы играете ${myColor === 'white' ? 'белыми' : 'чёрными'}. Ждём соперника…`);
    showNetControls();
    render();
  }

  async function join(): Promise<void> {
    if (!net) return;
    const addr = $<HTMLInputElement>('duo-addr').value;
    saveName();
    setNetStatus('Подключаюсь…');
    const r = await net.join(addr, myName());
    if (!r.ok) {
      setNetStatus(r.error ?? 'Не удалось подключиться', 'bad');
      return;
    }
    role = 'guest';
    connected = true;
    hostColor = r.hostColor!;
    myColor = other(hostColor);
    tc = TIME_CONTROLS.find((t) => t.base === r.tc?.base && t.inc === r.tc?.inc) ?? TIME_CONTROLS[0];
    timeSel.value = String(TIME_CONTROLS.indexOf(tc));
    names[myColor] = myName();
    names[hostColor] = r.hostName || 'Соперник';
    setNetStatus(`Подключено. Вы играете ${myColor === 'white' ? 'белыми' : 'чёрными'} против ${names[hostColor]}.`, 'ok');
    showNetControls();
    startGame(r.startFen || STANDARD_FEN);
  }

  async function leave(): Promise<void> {
    coach.cancel();
    await net?.leave();
    role = null;
    connected = false;
    started = false;
    stopClock(false);
    setNetStatus('Вы отключились');
    showNetControls();
    render();
  }

  /** Реванш: цвета меняются, расстановку (обычную или 960) выбрал тот, кто предложил реванш. */
  function startRematch(fen: string): void {
    hostColor = other(hostColor);
    myColor = role === 'host' ? hostColor : other(hostColor);
    if (role === 'host') void net?.update({ hostColor, startFen: fen });
    const n = { ...names };
    names.white = n.black;
    names.black = n.white;
    setNetStatus(`Реванш! Теперь вы играете ${myColor === 'white' ? 'белыми' : 'чёрными'}.`, 'ok');
    startGame(fen);
  }

  let offeredFen = STANDARD_FEN;

  function onNetEvent(ev: NetEvent): void {
    if (mode !== 'net' || !role || ev.from === role) return;
    switch (ev.type) {
      case 'joined':
        connected = true;
        names[other(myColor)] = String(ev.data?.name || 'Соперник').slice(0, 20);
        $('duo-code').classList.add('hidden');
        setNetStatus(`${names[other(myColor)]} подключился. Вы играете ${myColor === 'white' ? 'белыми' : 'чёрными'}.`, 'ok');
        startGame();
        break;
      case 'move': {
        if (!started || over || pos.turn === myColor) return;
        const move = parseUci(String(ev.data?.uci ?? ''));
        if (!move || !pos.isLegal(move)) {
          setNetStatus('Пришёл невозможный ход — партии разошлись. Начните реванш.', 'bad');
          return;
        }
        doMove(move, typeof ev.data?.clock === 'number' ? ev.data.clock : undefined);
        break;
      }
      case 'resign':
        finish(myColor, 'Соперник сдался', 'resign');
        break;
      case 'flag':
        finish(myColor, 'У соперника кончилось время', 'time');
        break;
      case 'draw-offer':
        if (!over) offer = 'draw';
        playSound('notify');
        render();
        break;
      case 'draw-accept':
        finish(null, 'Ничья по соглашению', 'draw');
        break;
      case 'draw-decline':
        setNetStatus('Соперник отказался от ничьей');
        break;
      case 'rematch-offer':
        offer = 'rematch';
        offeredFen = typeof ev.data?.fen === 'string' ? ev.data.fen : STANDARD_FEN;
        playSound('notify');
        render();
        // Оба нажали «Реванш» одновременно — соглашается гость, чтобы расстановка была одна (хозяина).
        if (myRematchSent && role === 'guest') acceptOffer();
        break;
      case 'rematch-accept':
        startRematch(myRematchFen);
        break;
      case 'left':
        connected = false;
        setNetStatus('Соперник отключился', 'bad');
        if (role === 'host') {
          // Комната закрыта для повторного входа — предлагаем создать новую игру.
          void net?.leave();
          role = null;
          showNetControls();
        }
        render();
        break;
    }
  }

  function acceptOffer(): void {
    if (offer === 'draw') {
      void net?.send('draw-accept');
      finish(null, 'Ничья по соглашению', 'draw');
    } else if (offer === 'rematch') {
      void net?.send('rematch-accept');
      offer = null;
      startRematch(offeredFen);
    }
  }

  function declineOffer(): void {
    if (offer === 'draw') void net?.send('draw-decline');
    offer = null;
    render();
  }

  function saveName(): void {
    try {
      localStorage.setItem('chesscoach.name', nameInput.value.trim());
    } catch {
      /* не сохранилось — не страшно */
    }
  }

  // ---------- общие кнопки ----------

  function resign(): void {
    if (!started || over) return;
    if (mode === 'local') {
      const who = pos.turn;
      if (!confirm(`${COLOR_NAME[who]} сдаются?`)) return;
      finish(other(who), `${COLOR_NAME[who]} сдались`, 'resign');
    } else {
      if (!confirm('Сдаться? Партия будет засчитана как поражение.')) return;
      void net?.send('resign');
      finish(other(myColor), 'Вы сдались', 'resign');
    }
  }

  function draw(): void {
    if (!started || over) return;
    if (mode === 'local') {
      if (confirm('Оба игрока согласны на ничью?')) finish(null, 'Ничья по соглашению', 'draw');
    } else {
      myDrawAt = ucis.length;
      void net?.send('draw-offer');
      setNetStatus('Вы предложили ничью — ждём ответа соперника');
      render();
    }
  }

  function again(): void {
    if (mode === 'local') return newLocalGame();
    if (!connected) {
      setNetStatus('Соперник не на связи — создайте новую игру', 'bad');
      return;
    }
    if (offer === 'rematch') return acceptOffer();
    myRematchSent = true;
    myRematchFen = newFen();
    void net?.send('rematch-offer', { fen: myRematchFen });
    setNetStatus('Вы предложили реванш — ждём соперника');
  }

  function toPgn(): string {
    const result = !over ? '*' : over.winner === null ? '1/2-1/2' : over.winner === 'white' ? '1-0' : '0-1';
    const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');
    const tcTag = timed() ? `[TimeControl "${tc.base * 60}+${tc.inc}"]\n` : '';
    const term = over ? `[Termination "${over.reason}"]\n` : '';
    const v960 = is960 ? `[Variant "Chess960"]\n[SetUp "1"]\n[FEN "${startFen}"]\n` : '';
    return `[White "${names.white}"]\n[Black "${names.black}"]\n[Result "${result}"]\n${v960}${tcTag}${term}\n${body} ${result}\n`;
  }

  net?.onEvent(onNetEvent);
  net?.onStatus((st) => {
    if (role !== 'guest') return;
    connected = st.connected;
    if (!st.connected) setNetStatus(st.reason ?? 'Связь потеряна', 'bad');
    render();
  });

  modeSel.onchange = () => setMode(modeSel.value as 'local' | 'net');
  timeSel.onchange = () => {
    if (mode === 'local' && (!started || ucis.length === 0 || over)) newLocalGame();
  };
  autoflip.onchange = () => {
    if (mode === 'local' && autoflip.checked) orientation = pos.turn;
    render();
  };
  sounds.onchange = () => setSoundsEnabled(sounds.checked);
  $('duo-new').onclick = newLocalGame;
  $('duo-undo').onclick = undoLocal;
  $('duo-resign').onclick = resign;
  $('duo-draw').onclick = draw;
  $('duo-flip').onclick = () => {
    orientation = other(orientation);
    render();
  };
  $('duo-host').onclick = () => void host();
  $('duo-join').onclick = () => void join();
  $<HTMLInputElement>('duo-addr').onkeydown = (e) => {
    if (e.key === 'Enter') void join();
  };
  $('duo-leave').onclick = () => void leave();
  $('duo-offer-yes').onclick = acceptOffer;
  $('duo-offer-no').onclick = declineOffer;
  $('duo-over-again').onclick = again;
  $('duo-over-review').onclick = () => openReview(toPgn());
  $('duo-over-close').onclick = () => $('duo-over').classList.add('hidden');
  $('duo-review').onclick = () => openReview(toPgn());
  $('duo-clip').onclick = () => {
    const m = coach.clipMoment(!!over);
    if (m) void showClip(m);
  };

  setMode('local');
}

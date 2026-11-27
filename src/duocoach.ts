// Комментатор партии двух людей (за одним компьютером и по сети): движок оценивает каждый ход,
// комментатор ругает или хвалит того, кто ходил, ведёт ауру и серию каждой стороны, чат «стрима»
// и запоминает яркие моменты для клипа. Всё считается на своём компьютере — по сети ничего не уходит.
import { Engine, type Line } from './engine';
import {
  $, GRADE_LABEL, GRADE_MARK, cpLossFor, grade, posFromFen, terminalLine, winPctFor, type Grade, type Side,
} from './shared';
import { pickRoast, type RoastKey } from './roast';
import { say } from './voice';
import { playSound } from './sounds';
import { auraPopup, fmtAura, lions, shake, sigma, wasted, zoomPunch } from './fx';
import { StreamChat, type ChatLine } from './chat';
import type { Tone } from './memes';
import type { ClipMoment } from './clip';

const DEPTH = 12;
const AURA: Record<Grade, number> = { best: 1000, good: 300, inaccuracy: -200, mistake: -500, blunder: -1000 };
/** Фразы про бота в партии двух людей не к месту. */
const NOT_HERE = /бот/i;

const other = (c: Side): Side => (c === 'white' ? 'black' : 'white');

/** Что знает о партии экран «Два игрока». */
export interface DuoView {
  names: Record<Side, string>;
  /** Мой цвет по сети; за одним компьютером — null (комментируем обоих одинаково). */
  me(): Side | null;
  startFen(): string;
  ucis(): string[];
  is960(): boolean;
  orientation(): Side;
}

export interface DuoMove {
  fenBefore: string;
  fenAfter: string;
  uci: string;
  san: string;
  mover: Side;
  /** Номер полухода после этого хода (ucis.length). */
  ply: number;
  capture: boolean;
  check: boolean;
  /** Ход закончил партию — реплику скажет end(). */
  end: boolean;
}

export type EndHow = 'mate' | 'time' | 'resign' | 'draw';

export class DuoCoach {
  private engine: Engine | null = null;
  private cache = new Map<string, Promise<Line | null>>();
  private game = 0;
  private aura: Record<Side, number> = { white: 0, black: 0 };
  private streak: Record<Side, number> = { white: 0, black: 0 };
  private moments: ClipMoment[] = [];
  private chat: StreamChat;
  private coachOn = $<HTMLInputElement>('duo-coach');
  private toneSel = $<HTMLSelectElement>('duo-tone');
  private chatOn = $<HTMLInputElement>('duo-chat-on');
  private voiceOn = $<HTMLInputElement>('duo-voice');

  constructor(private wrap: HTMLElement, private view: DuoView, private onMoments: () => void) {
    this.chat = new StreamChat($('duo-chat-list'), $('duo-chat-viewers'), () => this.voiceOn.checked);
    try {
      this.toneSel.value = localStorage.getItem('chesscoach.tone') ?? 'hard';
      this.chatOn.checked = localStorage.getItem('chesscoach.chat') !== 'off';
      this.coachOn.checked = localStorage.getItem('chesscoach.duoCoach') !== 'off';
    } catch {
      /* без хранилища — по умолчанию */
    }
    if (!this.toneSel.value) this.toneSel.value = 'hard';
    const store = (k: string, v: string) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* не сохранилось — не страшно */
      }
    };
    this.toneSel.onchange = () => store('chesscoach.tone', this.toneSel.value);
    this.coachOn.onchange = () => {
      store('chesscoach.duoCoach', this.coachOn.checked ? 'on' : 'off');
      this.drawAura();
    };
    this.chatOn.onchange = () => {
      store('chesscoach.chat', this.chatOn.checked ? 'on' : 'off');
      this.syncChat();
    };
    this.syncChat();
    this.drawAura();
  }

  private syncChat(): void {
    $('duo-chat').classList.toggle('hidden', !this.chatOn.checked);
    this.chat.setEnabled(this.chatOn.checked);
  }

  /** Новая партия: аура, серии, чат и моменты с нуля. */
  newGame(): void {
    this.cancel();
    this.aura = { white: 0, black: 0 };
    this.streak = { white: 0, black: 0 };
    this.moments = [];
    this.onMoments();
    this.chat.reset();
    this.chat.push('start');
    this.wrap.classList.remove('fx-wasted');
    $('duo-feedback').textContent = '';
    this.drawAura();
  }

  /** Ход назад за одним компьютером: недосчитанные оценки отменяются, ход назад стоит ауры. */
  undo(side: Side): void {
    this.cancel();
    this.moments = this.moments.filter((m) => m.ucis.length <= this.view.ucis().length);
    this.onMoments();
    this.streak[side] = 0;
    if (this.coachOn.checked) this.changeAura(side, -300, 'ход назад');
    this.chat.push('mistake', 0.7);
  }

  /** Сторона отключилась или партия брошена — дальше не комментируем. */
  cancel(): void {
    this.game++;
    this.engine?.cancel();
    this.cache.clear();
  }

  hasMoments(): boolean {
    return this.moments.length > 0;
  }

  /** Для клипа: во время партии — последний момент, после — самый яркий. */
  clipMoment(best: boolean): ClipMoment | undefined {
    if (!best) return this.moments.at(-1);
    return this.moments.reduce<ClipMoment | undefined>((b, m) => (!b || m.drama >= b.drama ? m : b), undefined);
  }

  /** Строка для окна итога. */
  auraSummary(): string {
    const { names } = this.view;
    return `Аура: ⚪ ${names.white} ${fmtAura(this.aura.white) || '0'} · ⚫ ${names.black} ${fmtAura(this.aura.black) || '0'}`;
  }

  /** К кому обращаемся: по сети к себе — без имени, к сопернику и за одним компьютером — по имени. */
  private who(side: Side): string {
    return this.view.me() === side ? '' : this.view.names[side];
  }

  private evalFen(fen: string): Promise<Line | null> {
    const end = terminalLine(posFromFen(fen));
    if (end) return Promise.resolve(end);
    let p = this.cache.get(fen);
    if (!p) {
      this.engine ??= new Engine();
      p = this.engine.analyse(fen, { depth: DEPTH, chess960: this.view.is960() }).then((r) => r?.lines[0] ?? null);
      this.cache.set(fen, p);
      p.then((line) => {
        if (!line) this.cache.delete(fen);
      });
    }
    return p;
  }

  /** Ход любой стороны: оценка, эффекты, аура, чат, реплика. */
  async onMove(m: DuoMove): Promise<void> {
    if (!m.end) {
      if (m.check) this.chat.push('check', 0.6);
      else if (m.capture) this.chat.push('botCapture', 0.4);
    }
    if (!this.coachOn.checked) return;
    const g0 = this.game;
    const [before, after] = await Promise.all([this.evalFen(m.fenBefore), this.evalFen(m.fenAfter)]);
    if (g0 !== this.game || !before || !after) return;
    const side = m.mover;
    const loss = Math.max(0, winPctFor(before.cp, side) - winPctFor(after.cp, side));
    const cpLoss = cpLossFor(before.cp, after.cp, side);
    const g = grade(loss, before.pv[0] === m.uci, cpLoss);
    const legalCount = [...posFromFen(m.fenBefore).allDests().values()].reduce((n, set) => n + set.size(), 0);
    const good = g === 'best' || g === 'good';
    const myCp = side === 'white' ? before.cp : -before.cp;

    // Серия сильных ходов у каждой стороны своя.
    let milestone: RoastKey | null = null;
    if (legalCount > 1) {
      if (good) {
        const s = ++this.streak[side];
        if (s === 3) milestone = 'streak3';
        else if (s === 5) milestone = 'streak5';
        else if (s >= 8 && s % 4 === 0) milestone = 'streak8';
      } else {
        if (this.streak[side] >= 3) milestone = 'streakBroken';
        this.streak[side] = 0;
      }
    }
    const hot = !!milestone && milestone !== 'streakBroken';
    const streak = this.streak[side];

    const name = this.view.names[side];
    const label = `${name}: ${m.san}${GRADE_MARK[g]} — ${GRADE_LABEL[g].toLowerCase()}`;
    if (m.end) {
      $('duo-feedback').innerHTML = '';
      return;
    }

    // Эффекты над доской.
    if (g === 'blunder') {
      shake(this.wrap, true);
      const to = m.uci.slice(2, 4);
      const fx = (to.charCodeAt(0) - 97 + 0.5) / 8;
      const fy = (8 - Number(to[1]) + 0.5) / 8;
      const white = this.view.orientation() === 'white';
      zoomPunch(this.wrap, white ? fx : 1 - fx, white ? fy : 1 - fy);
      playSound('boom');
    } else if (g === 'mistake') {
      shake(this.wrap, false);
      playSound('womp');
    }
    if (hot) {
      lions(this.wrap, 28, `ЛЕВЬ ×${streak}`);
      playSound('sigma');
    } else if (g === 'best' && legalCount > 1) lions(this.wrap, 7);

    // Аура: единственный ход и «хороший ход в проигранной» не считаются; в серии — вдвое.
    let delta = legalCount === 1 || (good && myCp <= -600) ? 0 : AURA[g];
    if (good && streak >= 3) delta *= 2;
    this.changeAura(side, delta, hot ? `${name} · серия ×${streak}` : this.view.me() === null ? name : undefined);

    // Чат: зевок — ржут, сильный ход — «сигма».
    const chatLines = this.chat.push(hot ? 'streak' : g, g === 'good' ? 0.5 : 1);
    const tip = g === 'blunder' ? this.chat.donate('bad', 0.2) : g === 'best' || hot ? this.chat.donate('good', 0.12) : null;
    if (tip) chatLines.push(tip);

    let key: RoastKey = g;
    if (legalCount === 1) key = 'forced';
    else if (milestone) key = milestone;
    else if (good && myCp <= -600) key = 'doomed';
    const drama =
      g === 'blunder' ? 5 + loss / 20
      : g === 'mistake' ? 3
      : hot ? 3.5 + streak / 10
      : g === 'best' ? 2
      : 1;
    this.out(key, g, side, label, {
      ply: m.ply, verdict: label, mark: g === 'best' ? '!' : GRADE_MARK[g], drama, aura: delta, chat: chatLines,
    });
  }

  /**
   * Конец партии: аура за концовку, эффекты, чат, реплика.
   * Возвращает, через сколько мс показать окно итога (чтобы успели «ПОТРАЧЕНО» и моаи).
   */
  end(winner: Side | null, how: EndHow, title: string, reason: string): number {
    this.game++; // недосчитанные оценки ходов уже не нужны
    this.engine?.cancel();
    const me = this.view.me();
    const ply = this.view.ucis().length;
    const coach = this.coachOn.checked;
    let delay = 0;
    let chatLines: ChatLine[];
    let wastedHere = false;
    const plus = how === 'mate' ? 5000 : how === 'time' ? 2000 : 3000;
    const minus = how === 'resign' ? -2000 : how === 'time' ? -1500 : -5000;

    if (winner) {
      const loser = other(winner);
      if (coach) {
        // Над доской всплывает аура победителя, а по сети — своя.
        this.changeAura(winner, plus, me === null ? this.view.names[winner] : undefined, me !== null && me !== winner);
        this.changeAura(loser, minus, undefined, me !== loser);
      }
      if (me === loser && how !== 'resign') {
        // По сети мне поставили мат или упал мой флажок — «ПОТРАЧЕНО».
        wasted(this.wrap);
        playSound('sad');
        chatLines = this.chat.push('mated');
        wastedHere = true;
        delay = 2300;
      } else if (me === loser) {
        chatLines = this.chat.push('resigned');
      } else {
        sigma(this.wrap, how === 'mate' ? 'СИГМА' : 'ПОБЕДА');
        playSound('sigma');
        chatLines = this.chat.push(how === 'resign' ? 'resigned' : 'win');
        delay = 1600;
      }
    } else {
      chatLines = this.chat.push('draw');
    }
    const tip = this.chat.donate(winner && me !== winner && me !== null ? 'bad' : 'good', winner === null ? 0 : 0.5);
    if (tip) chatLines.push(tip);

    // Реплика: за одним компьютером — проигравшему (смешнее), по сети — мне.
    let key: RoastKey;
    let target: Side | null;
    if (winner === null) {
      key = 'draw';
      target = null;
    } else if (me === null) {
      target = other(winner);
      key = how === 'time' ? 'flagged' : how === 'resign' ? 'resigned' : 'mated';
    } else if (me === winner) {
      target = me;
      key = 'win';
    } else {
      target = me;
      key = how === 'time' ? 'flagged' : how === 'resign' ? 'resigned' : 'mated';
    }
    const cls = winner === null ? 'good' : me === null || me === winner ? 'best' : 'blunder';
    this.out(key, cls, target, reason, {
      ply,
      verdict: `${title} — ${reason.toLowerCase()}`,
      mark: how === 'mate' ? '#' : '',
      drama: winner === null ? 2 : how === 'mate' ? 100 : 3,
      aura: coach && winner ? (me === null || me === winner ? plus : minus) : 0,
      chat: chatLines,
      wasted: wastedHere,
    });
    return delay;
  }

  private changeAura(side: Side, delta: number, note?: string, quiet = false): void {
    if (!delta) return;
    this.aura[side] += delta;
    if (!quiet) auraPopup(this.wrap, delta, note);
    this.drawAura();
  }

  private drawAura(): void {
    const el = $('duo-aura');
    el.classList.toggle('hidden', !this.coachOn.checked);
    el.textContent = `⚪ ${fmtAura(this.aura.white) || '0'} · ⚫ ${fmtAura(this.aura.black) || '0'}`;
  }

  /** Реплика над партией (и голосом) + момент для клипа. target — к кому обращаемся. */
  private out(
    key: RoastKey,
    cls: string,
    target: Side | null,
    label: string,
    clip: { ply: number; verdict: string; mark: string; drama: number; aura?: number; chat?: ChatLine[]; wasted?: boolean },
  ): void {
    const tone = this.toneSel.value as Tone | 'off';
    const phrase = tone === 'off' ? null : pickRoast(key, tone, NOT_HERE);
    const name = target ? this.who(target) : '';
    const shown = phrase && name ? `${name}: ${phrase}` : phrase;
    const { names } = this.view;
    const ucis = this.view.ucis().slice(0, clip.ply);
    if (ucis.length) {
      const { ply, ...rest } = clip;
      this.moments = this.moments.filter((m) => m.ucis.length !== ply);
      this.moments.push({
        startFen: this.view.startFen(), ucis, orientation: this.view.me() ?? (target ?? 'white'),
        phrase, cls, title: `⚪ ${names.white} vs ⚫ ${names.black}`, ...rest,
      });
      this.onMoments();
    }
    const fb = $('duo-feedback');
    fb.replaceChildren();
    if (shown) {
      const b = document.createElement('b');
      b.className = `${cls} roast`;
      b.textContent = shown;
      fb.append(b, document.createElement('br'));
    }
    const v = document.createElement('span');
    v.className = 'muted';
    v.textContent = label;
    fb.append(v);
    if (phrase && this.voiceOn.checked) say(phrase);
  }
}

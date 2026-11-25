// Чат «стрима»: зрители реагируют на ходы, растёт счётчик зрителей, иногда приходят донаты.
// Всё выдумано и считается на месте — это шоу, а не настоящие люди.
import { CHAT, DONATIONS, NICKS, type ChatEvent } from './memes';
import { playSound } from './sounds';

export type ChatLine = [nick: string, text: string];

/** Сколько сообщений приходит на событие: [от, до]. */
const BURST: Record<ChatEvent, [number, number]> = {
  blunder: [4, 7], mistake: [2, 3], inaccuracy: [0, 1], good: [0, 2], best: [2, 4], move: [0, 1], check: [1, 2],
  botCapture: [0, 2], mated: [6, 9], win: [6, 9], draw: [2, 3], resigned: [3, 5], start: [2, 3], streak: [3, 5],
};

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

function nickColor(nick: string): string {
  let h = 0;
  for (const c of nick) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 65%)`;
}

export class StreamChat {
  private token = 0;
  private viewers = 0;
  private enabled = true;

  constructor(private list: HTMLElement, private counter: HTMLElement) {
    this.reset();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.token++;
  }

  reset(): void {
    this.token++;
    this.list.replaceChildren();
    this.viewers = rnd(120, 480);
    this.drawViewers();
  }

  /** Реакция чата; возвращает сообщения (для клипа), сами они приходят с небольшими задержками. */
  push(ev: ChatEvent, chance = 1): ChatLine[] {
    if (Math.random() > chance) return [];
    const [a, b] = BURST[ev];
    const n = rnd(a, b);
    const used = new Set<string>();
    const lines: ChatLine[] = [];
    for (let i = 0; i < n; i++) {
      let text = pick(CHAT[ev]);
      for (let k = 0; k < 4 && used.has(text); k++) text = pick(CHAT[ev]);
      used.add(text);
      lines.push([pick(NICKS), text]);
    }
    // Зрители: на зевок и мат сбегаются поржать, на сильный ход — посмотреть.
    const grow: Partial<Record<ChatEvent, number>> = { blunder: 0.25, mated: 0.4, win: 0.3, best: 0.08, streak: 0.12, mistake: 0.06 };
    this.viewers = Math.round(this.viewers * (1 + (grow[ev] ?? 0)) + rnd(-6, 9));
    this.drawViewers();
    if (!this.enabled) return lines;
    const t = this.token;
    let delay = rnd(150, 400);
    for (const line of lines) {
      setTimeout(() => t === this.token && this.add(line), delay);
      delay += rnd(120, 450);
    }
    return lines;
  }

  /** Донат: bad — на провал, good — на сильный ход. Возвращает строку для клипа. */
  donate(kind: 'bad' | 'good', chance: number): ChatLine | null {
    if (!this.enabled || Math.random() > chance) return null;
    const amount = pick([50, 100, 100, 200, 300, 500, 1000]);
    const line: ChatLine = [`💸 ${pick(NICKS)} · ${amount} ₽`, pick(DONATIONS[kind])];
    const t = this.token;
    setTimeout(() => {
      if (t !== this.token) return;
      this.add(line, true);
      playSound('donate');
    }, rnd(900, 1600));
    return line;
  }

  private add([nick, text]: ChatLine, donation = false): void {
    const el = document.createElement('div');
    el.className = `chat-msg${donation ? ' donation' : ''}`;
    const b = document.createElement('b');
    b.textContent = nick;
    b.style.color = donation ? '' : nickColor(nick);
    el.append(b, donation ? document.createElement('br') : ': ', text);
    this.list.append(el);
    while (this.list.children.length > 40) this.list.firstElementChild!.remove();
    this.list.scrollTop = this.list.scrollHeight;
  }

  private drawViewers(): void {
    this.counter.textContent = `🔴 LIVE · 👁 ${this.viewers.toLocaleString('ru-RU')}`;
  }
}

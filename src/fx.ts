// Эффекты над доской: тряска и красная вспышка за зевок, львы за сильный ход, салют за серию.

/**
 * Красная вспышка поверх доски. strong — зевок, иначе ошибка (слабее).
 * Саму доску не двигаем: chessground считает клетки по её размерам, и от тряски фигуры разлетаются.
 */
export function shake(wrap: HTMLElement, strong: boolean): void {
  const flash = document.createElement('div');
  flash.className = `fx-flash ${strong ? 'strong' : ''}`;
  wrap.append(flash);
  setTimeout(() => flash.remove(), 700);
}

/** Львы разлетаются из центра доски; big — салют за серию с надписью. */
export function lions(wrap: HTMLElement, count: number, label?: string): void {
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'fx-lion';
    s.textContent = '🦁';
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const dist = 120 + Math.random() * 180;
    s.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    s.style.setProperty('--rot', `${(Math.random() - 0.5) * 120}deg`);
    s.style.animationDelay = `${Math.random() * 120}ms`;
    s.style.fontSize = `${26 + Math.random() * 26}px`;
    layer.append(s);
  }
  if (label) {
    const t = document.createElement('div');
    t.className = 'fx-label';
    t.textContent = label;
    layer.append(t);
  }
  wrap.append(layer);
  setTimeout(() => layer.remove(), 1800);
}

/** Всплывающая аура над доской: «−1 000 АУРЫ». */
export function auraPopup(wrap: HTMLElement, delta: number, note?: string): void {
  if (!delta) return;
  const el = document.createElement('div');
  el.className = `fx-aura ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta) >= 1000 ? 'big' : ''}`;
  el.textContent = `${fmtAura(delta)} ауры`;
  if (note) {
    const n = document.createElement('small');
    n.textContent = note;
    el.append(n);
  }
  wrap.append(el);
  setTimeout(() => el.remove(), 1700);
}

/** «+1 000», «−5 000» — с тонким пробелом в тысячах и настоящим минусом. */
export function fmtAura(n: number): string {
  const s = Math.abs(Math.round(n)).toLocaleString('ru-RU');
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${s}`;
}

/** Зевок: красное кольцо пульсирует на клетке (доли от левого верхнего угла доски). Доска стоит на месте. */
export function zoomPunch(wrap: HTMLElement, x: number, y: number): void {
  const board = wrap.querySelector<HTMLElement>('.board');
  if (!board) return;
  const ring = document.createElement('div');
  ring.className = 'fx-ring';
  const size = board.offsetWidth / 8;
  ring.style.width = ring.style.height = `${size}px`;
  ring.style.left = `${board.offsetLeft + x * board.offsetWidth - size / 2}px`;
  ring.style.top = `${board.offsetTop + y * board.offsetHeight - size / 2}px`;
  wrap.append(ring);
  setTimeout(() => ring.remove(), 1000);
}

/** «ПОТРАЧЕНО»: доска серая, крупная надпись. Через ms убирается сама. */
export function wasted(wrap: HTMLElement, ms = 2600): void {
  wrap.classList.add('fx-wasted');
  const t = document.createElement('div');
  t.className = 'fx-wasted-text';
  t.textContent = 'ПОТРАЧЕНО';
  wrap.append(t);
  setTimeout(() => {
    wrap.classList.remove('fx-wasted');
    t.remove();
  }, ms);
}

/** Победа: моаи 🗿 и надпись, вместе со львами. */
export function sigma(wrap: HTMLElement, label = 'СИГМА'): void {
  const el = document.createElement('div');
  el.className = 'fx-sigma';
  el.innerHTML = `<span>🗿</span><b>${label}</b>`;
  wrap.append(el);
  setTimeout(() => el.remove(), 2400);
}

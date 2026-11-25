// Звуки партии без файлов: короткие сигналы синтезирует Web Audio.
export type SoundKind = 'move' | 'capture' | 'check' | 'end' | 'lowtime' | 'notify' | 'boom' | 'womp' | 'sad' | 'sigma' | 'donate';

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
}

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Куда играть: по умолчанию — в колонки; для клипа — в дорожку записи с момента at. */
interface Out {
  ctx: BaseAudioContext;
  dest: AudioNode;
  at: number;
}
let out: Out | null = null;

/** Один тон: частота, длительность, форма волны, громкость, задержка (всё в секундах). */
function tone(freq: number, dur: number, type: OscillatorType, gain: number, delay = 0, endFreq?: number): void {
  const a = out?.ctx ?? audio();
  if (!a) return;
  const t = (out ? out.at : a.currentTime) + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out?.dest ?? a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** Тот же звук, но в дорожку записи клипа: ctx и dest записи, at — время в ctx. */
export function scheduleSound(kind: SoundKind, ctx: BaseAudioContext, dest: AudioNode, at: number): void {
  out = { ctx, dest, at };
  try {
    synth(kind);
  } finally {
    out = null;
  }
}

export function playSound(kind: SoundKind): void {
  if (!enabled) return;
  synth(kind);
}

function synth(kind: SoundKind): void {
  switch (kind) {
    case 'move': // «тук» фигуры о доску
      tone(420, 0.07, 'triangle', 0.35, 0, 180);
      break;
    case 'capture': // двойной, пожёстче
      tone(300, 0.06, 'square', 0.18, 0, 120);
      tone(520, 0.09, 'triangle', 0.3, 0.05, 160);
      break;
    case 'check':
      tone(880, 0.12, 'sine', 0.25);
      tone(1175, 0.18, 'sine', 0.25, 0.1);
      break;
    case 'end':
      tone(523, 0.25, 'sine', 0.22);
      tone(659, 0.25, 'sine', 0.22, 0.15);
      tone(784, 0.45, 'sine', 0.22, 0.3);
      break;
    case 'lowtime':
      tone(1000, 0.08, 'square', 0.12);
      tone(1000, 0.08, 'square', 0.12, 0.15);
      break;
    case 'notify':
      tone(660, 0.12, 'sine', 0.2);
      break;
    case 'boom': // глухой мемный «бум» на зевке
      tone(120, 0.9, 'sine', 0.75, 0, 32);
      tone(240, 0.3, 'triangle', 0.35, 0, 60);
      tone(60, 0.6, 'square', 0.08, 0.01, 30);
      break;
    case 'womp': // «вомп» на ошибке
      tone(300, 0.22, 'sawtooth', 0.12, 0, 200);
      tone(220, 0.35, 'sawtooth', 0.12, 0.2, 140);
      break;
    case 'sad': // грустный тромбон на мате
      tone(392, 0.32, 'sawtooth', 0.12, 0, 380);
      tone(370, 0.32, 'sawtooth', 0.12, 0.36, 358);
      tone(349, 0.32, 'sawtooth', 0.12, 0.72, 338);
      tone(330, 1.1, 'sawtooth', 0.12, 1.08, 290);
      break;
    case 'sigma': // бас вверх и аккорд — победа, серия
      tone(55, 0.5, 'square', 0.12, 0, 110);
      tone(523, 0.5, 'sine', 0.18, 0.35);
      tone(659, 0.5, 'sine', 0.18, 0.42);
      tone(784, 0.8, 'sine', 0.18, 0.5);
      tone(1047, 0.9, 'sine', 0.12, 0.6);
      break;
    case 'donate': // звон монетки
      tone(1318, 0.09, 'sine', 0.22);
      tone(1760, 0.22, 'sine', 0.22, 0.08);
      break;
  }
}

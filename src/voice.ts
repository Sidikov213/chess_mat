// Озвучка реплик тренера — общая для игры с ботом и для партии двух игроков.
import { VOICE } from './roast';
import { BOT_VOICE, CHAT_VOICE, DONATE_VOICE } from './voicemap-extra';

// Голоса в Chromium приходят не сразу: запрашиваем заранее, чтобы первая реплика уже была по-русски.
window.speechSynthesis?.getVoices();
if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();

declare global {
  interface Window {
    coachVoice?: { synth: (text: string) => Promise<string | null> };
  }
}

let audio: HTMLAudioElement | null = null;
let sayToken = 0;

const playing = (a: HTMLAudioElement | null) => !!a && !a.paused && !a.ended;

/** Тренер говорит: голоса ботов и чата замолкают и ждут своей очереди. */
function startCoach(a: HTMLAudioElement): void {
  audio = a;
  side?.pause();
  side = null;
  a.addEventListener('ended', nextSide);
  a.addEventListener('error', nextSide);
  void a.play().catch(nextSide); // прервали новой репликой — это нормально
}

/** Озвучка реплики: записи ElevenLabs, иначе мужской голос Windows Pavel, иначе голос браузера. */
export function say(raw: string): void {
  const text = raw.replace(/\p{Extended_Pictographic}/gu, '');
  const token = ++sayToken;
  audio?.pause();
  window.speechSynthesis?.cancel();
  const file = VOICE[raw];
  if (file) {
    startCoach(new Audio(`voice/${file}.mp3`));
  } else if (window.coachVoice) {
    void window.coachVoice.synth(text).then((b64) => {
      if (token !== sayToken) return; // уже сказали что-то новее
      if (b64) startCoach(new Audio(`data:audio/wav;base64,${b64}`));
      else browserSay(text);
    });
  } else browserSay(text);
}

// Второй канал: боты, донаты и чат «стрима». Тренера не перебивают — говорят после него, по очереди.
type Side = { file: string; volume: number; until: number };
let side: HTMLAudioElement | null = null;
let queue: Side[] = [];

function nextSide(): void {
  if (playing(audio) || playing(side)) return;
  const now = Date.now();
  queue = queue.filter((q) => q.until > now); // устаревшее уже не к месту
  const q = queue.shift();
  if (!q) return;
  const a = new Audio(`voice/${q.file}.mp3`);
  a.volume = q.volume;
  side = a;
  a.addEventListener('ended', nextSide);
  a.addEventListener('error', nextSide);
  void a.play().catch(nextSide);
}

function sideSay(file: string | undefined, volume: number, waitMs: number): void {
  if (!file) return;
  queue.push({ file, volume, until: Date.now() + waitMs });
  // Даём тренеру шанс начать первым: его реплика приходит в тот же момент.
  setTimeout(nextSide, 250);
}

/** Реплика бота-персонажа его голосом. */
export function sayBot(personaId: string, text: string): void {
  sideSay(BOT_VOICE[personaId]?.[text], 1, 8000);
}

/** Донат зачитывает отдельный голос. */
export function sayDonation(text: string): void {
  sideSay(DONATE_VOICE[text], 0.9, 10000);
}

/** Сообщение чата — только если сейчас тихо, чтобы зрители не орали хором. */
export function sayChat(text: string): void {
  if (playing(audio) || playing(side) || queue.length) return;
  sideSay(CHAT_VOICE[text], 0.75, 1500);
}

function browserSay(text: string): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ru-RU';
  const ru = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith('ru'));
  if (ru) u.voice = ru;
  u.rate = 1.05;
  synth.speak(u);
}


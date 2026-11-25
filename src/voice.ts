// Озвучка реплик тренера — общая для игры с ботом и для партии двух игроков.
import { VOICE } from './roast';

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

/** Озвучка реплики: записи ElevenLabs, иначе мужской голос Windows Pavel, иначе голос браузера. */
export function say(raw: string): void {
  const text = raw.replace(/\p{Extended_Pictographic}/gu, '');
  const token = ++sayToken;
  audio?.pause();
  window.speechSynthesis?.cancel();
  const file = VOICE[raw];
  if (file) {
    audio = new Audio(`voice/${file}.mp3`);
    void audio.play().catch(() => undefined); // прервали новой репликой — это нормально
  } else if (window.coachVoice) {
    void window.coachVoice.synth(text).then((b64) => {
      if (token !== sayToken) return; // уже сказали что-то новее
      if (b64) {
        audio = new Audio(`data:audio/wav;base64,${b64}`);
        void audio.play().catch(() => undefined); // прервали новой репликой — это нормально
      } else browserSay(text);
    });
  } else browserSay(text);
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


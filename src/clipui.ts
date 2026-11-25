// Окно «Клип»: живое превью записи, потом видео с кнопками «Скачать» и «Поделиться».
import { SITE_URL, clipSupported, recordClip, type ClipMoment } from './clip';
import { VOICE } from './roast';
import { $ } from './shared';

let busy = false;

/** Голос реплики для клипа: запись ElevenLabs, иначе Pavel из приложения. В браузере без записи — без голоса. */
async function voiceFor(phrase: string | null): Promise<string | null> {
  if (!phrase) return null;
  const file = VOICE[phrase];
  if (file) return `voice/${file}.mp3`;
  if (window.coachVoice) {
    const b64 = await window.coachVoice.synth(phrase.replace(/\p{Extended_Pictographic}/gu, '')).catch(() => null);
    if (b64) return `data:audio/wav;base64,${b64}`;
  }
  return null;
}

export async function showClip(m: ClipMoment): Promise<void> {
  if (busy) return;
  $('modal-title').textContent = '🎬 Клип для соцсетей';
  const body = $('modal-body');
  body.replaceChildren();
  $('modal').classList.remove('hidden');
  if (!clipSupported()) {
    body.textContent = 'Этот браузер не умеет записывать видео. Откройте сайт в Chrome, Edge или Firefox.';
    return;
  }
  busy = true;
  const box = document.createElement('div');
  box.className = 'clip';
  const stage = document.createElement('div');
  stage.className = 'clip-stage';
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  const side = document.createElement('div');
  side.className = 'clip-side';
  const status = document.createElement('div');
  status.className = 'clip-status';
  status.textContent = 'Записываю клип…';
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('div');
  fill.className = 'clip-progress';
  bar.append(fill);
  const actions = document.createElement('div');
  actions.className = 'clip-actions';
  side.append(status, bar, actions);
  box.append(stage, side);
  body.append(box);

  try {
    const voice = await voiceFor(m.phrase);
    const rec = await recordClip(m, voice, canvas, (q) => (fill.style.width = `${Math.round(q * 100)}%`));
    const url = URL.createObjectURL(rec.blob);
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    canvas.replaceWith(video);
    bar.remove();
    status.textContent = voice
      ? 'Готово. Вертикальное видео 9:16 — для TikTok, Reels и Shorts.'
      : 'Готово. Вертикальное видео 9:16. Голоса в клипе нет: у этой реплики нет записи.';
    const name = `chess-coach-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${rec.ext}`;
    const dl = document.createElement('a');
    dl.className = 'button primary';
    dl.href = url;
    dl.download = name;
    dl.textContent = '⬇ Скачать';
    actions.append(dl);
    const file = new File([rec.blob], name, { type: rec.blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      const share = document.createElement('button');
      share.textContent = '📤 Поделиться';
      share.onclick = () =>
        void navigator
          .share({ files: [file], title: 'Chess Coach', text: SITE_URL ? `Сыграй сам: ${SITE_URL}` : 'Chess Coach' })
          .catch(() => undefined);
      actions.append(share);
    }
    if (SITE_URL) {
      const copy = document.createElement('button');
      copy.textContent = '🔗 Ссылка на игру';
      copy.onclick = () =>
        void navigator.clipboard.writeText(SITE_URL).then(() => (copy.textContent = '✓ Скопировано'));
      actions.append(copy);
    }
  } catch (e) {
    status.textContent = `Не получилось записать клип: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy = false;
  }
}

// Окошко «Как тебя зовут?»: имя или ник для статистики. Только на сайте.
import { $ } from './shared';
import { NAME_MAX, playerName, setPlayerName, telemetryEnabled } from './telemetry';

const SKIP_KEY = 'chesscoach.name.skip';

function drawButton(): void {
  const btn = $('open-name');
  const name = playerName();
  btn.textContent = name ? `👤 ${name}` : '👤 Имя';
  btn.title = name ? 'Сменить имя' : 'Указать имя';
}

function open(first: boolean): void {
  const wrap = document.createElement('div');
  wrap.className = 'name-ask';
  wrap.innerHTML = `
    <form class="name-card">
      <div class="name-emoji">♟️</div>
      <h2>${first ? 'Как тебя зовут?' : 'Сменить имя'}</h2>
      <p>Имя или ник — чтобы мы видели, кто играет.</p>
      <input name="n" maxlength="${NAME_MAX}" placeholder="Например, Магомед" autocomplete="nickname" enterkeyhint="go" />
      <button class="primary" type="submit">${first ? 'Играть' : 'Сохранить'}</button>
      <button class="link" type="button">${first ? 'Пропустить' : 'Отмена'}</button>
    </form>`;
  const form = wrap.querySelector('form')!;
  const input = form.querySelector('input')!;
  const ok = form.querySelector<HTMLButtonElement>('button.primary')!;
  input.value = playerName();
  const sync = () => (ok.disabled = !input.value.trim());
  sync();
  input.oninput = sync;
  const close = () => wrap.remove();
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!setPlayerName(input.value)) return;
    drawButton();
    close();
  };
  form.querySelector<HTMLButtonElement>('button.link')!.onclick = () => {
    if (first) {
      try {
        sessionStorage.setItem(SKIP_KEY, '1'); // до закрытия вкладки больше не спрашиваем
      } catch {
        /* не страшно */
      }
    }
    close();
  };
  wrap.onclick = (e) => {
    if (e.target === wrap && !first) close();
  };
  document.body.append(wrap);
  setTimeout(() => input.focus(), 50);
}

export function initName(): void {
  if (!telemetryEnabled()) return;
  const btn = $('open-name');
  btn.classList.remove('hidden');
  btn.onclick = () => open(false);
  drawButton();
  let skipped = false;
  try {
    skipped = !!sessionStorage.getItem(SKIP_KEY);
  } catch {
    /* нет хранилища */
  }
  if (!playerName() && !skipped) open(true);
}

import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './style.css';
import { Engine } from './engine';
import { initPlay } from './play';
import { initDuo } from './duo';
import { initReview } from './review';
import { $ } from './shared';
import { renderAchievements } from './achievements';
import { deleteGame, loadHistory } from './history';
import { trackVisit } from './telemetry';
import { initName } from './name';

trackVisit();

const engine = new Engine();
engine
  .analyse('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 1 })
  .then(() => {
    $('engine-status').textContent = engine.kind === 'asm' ? 'Stockfish 19 готов (упрощённый режим)' : 'Stockfish 19 готов';
  });

const TABS = ['play', 'duo', 'review'] as const;
type Tab = (typeof TABS)[number];

function show(tab: Tab): void {
  for (const t of TABS) {
    $(`view-${t}`).classList.toggle('hidden', t !== tab);
    $(`tab-${t}`).classList.toggle('active', t === tab);
  }
  window.dispatchEvent(new Event('resize'));
  document.body.dispatchEvent(new Event('chessground.resize'));
}

const review = initReview(engine);
const openReview = (pgn: string) => {
  closeModal();
  show('review');
  review.load(pgn);
};
initPlay(engine, openReview);

// Сайт: офлайн-кэш (в приложении для компьютера адрес app://, там не нужен).
if (import.meta.env.PROD && location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('sw.js').catch(() => undefined);
}
initDuo(openReview);
initName();

for (const t of TABS) $(`tab-${t}`).onclick = () => show(t);

// ---------- окно поверх всего: история и достижения ----------

function openModal(title: string, fill: (body: HTMLElement) => void): void {
  $('modal-title').textContent = title;
  fill($('modal-body'));
  $('modal').classList.remove('hidden');
}

function closeModal(): void {
  $('modal').classList.add('hidden');
  for (const v of $('modal-body').querySelectorAll('video')) v.pause(); // клип не играет за закрытым окном
}

$('modal-close').onclick = closeModal;
$('modal').onclick = (e) => {
  if (e.target === $('modal')) closeModal();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

$('open-ach').onclick = () => openModal('🏆 Достижения', renderAchievements);
$('open-history').onclick = () => openModal('📜 История партий', renderHistory);

function renderHistory(body: HTMLElement): void {
  const list = loadHistory();
  body.replaceChildren();
  if (!list.length) {
    body.textContent = 'Пока ни одной законченной партии. Сыграйте — и она появится здесь.';
    return;
  }
  const w = list.filter((g) => g.score === 1).length;
  const d = list.filter((g) => g.score === 0.5).length;
  const sum = document.createElement('div');
  sum.className = 'hist-summary';
  sum.textContent = `Партий: ${list.length} · побед ${w}, ничьих ${d}, поражений ${list.length - w - d}` +
    ' (за одним компьютером «победа» — победа белых)';
  body.append(sum);
  const table = document.createElement('table');
  table.className = 'hist';
  table.innerHTML = '<thead><tr><th>Дата</th><th>Соперник</th><th>Цвет</th><th>Итог</th><th>Дебют</th><th>Ходов</th><th>Точность</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const g of list) {
    const tr = document.createElement('tr');
    const date = new Date(g.date).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const res = g.score === 1 ? ['res-w', g.myColor ? 'Победа' : '1–0'] : g.score === 0 ? ['res-l', g.myColor ? 'Поражение' : '0–1'] : ['res-d', 'Ничья'];
    const cells = [
      date,
      g.opponent,
      g.myColor === 'white' ? '⚪ белые' : g.myColor === 'black' ? '⚫ чёрные' : '—',
      '',
      g.opening ?? '—',
      String(Math.ceil(g.plies / 2)),
      g.accuracy === null ? '—' : `${g.accuracy}%`,
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    const resTd = tr.children[3] as HTMLElement;
    resTd.className = res[0];
    resTd.textContent = res[1];
    resTd.title = g.reason;
    const act = document.createElement('td');
    const open = document.createElement('button');
    open.textContent = 'Разобрать';
    open.onclick = () => openReview(g.pgn);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Удалить из истории';
    del.onclick = () => {
      deleteGame(g.id);
      renderHistory(body);
    };
    act.append(open, ' ', del);
    tr.append(act);
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);
}

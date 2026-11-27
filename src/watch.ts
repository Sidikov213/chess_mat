// Наблюдение за партией в админке: доска только для просмотра, обновляется опросом базы.
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import { posFromFen, type Side } from './shared';

const POLL_MS = 1500;
const RESULT_EVERY = 3; // результат проверяем каждый третий опрос

export interface LiveInfo {
  game_id: string;
  visitor_id: string;
  name: string | null;
  info: { mode?: string; bot_id?: string; bot_name?: string; bot_elo?: number; color?: Side; time_control?: string; chess960?: boolean } | null;
}

interface Snap {
  id: number;
  ts: string;
  ply: number;
  fen: string;
  last_uci: string | null;
  sans: string;
  clock_white: number | null;
  clock_black: number | null;
}

interface Result {
  result: string;
  how: string | null;
  reason: string | null;
}

type Api_ = (path: string, init?: RequestInit) => Promise<Response>;

const BOT_EMOJI: Record<string, string> = { kid: '👶', grandpa: '👴', troll: '🤡', tiger: '🐯', taxi: '🧔', eagle: '🦅', prof: '🧠', machine: '🤖' };

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function fmtClock(ms: number): string {
  if (ms < 10_000) return `0:0${(Math.max(0, ms) / 1000).toFixed(1)}`;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Открывает окно наблюдения. Возвращает функцию закрытия. */
export function openWatch(game: LiveInfo, api: Api_): () => void {
  const info = game.info ?? {};
  const isBot = info.mode === 'bot';
  const me: Side = isBot && info.color === 'black' ? 'black' : 'white';
  const playerName = game.name || `без имени · ${game.visitor_id.slice(0, 6)}`;
  const opponent = isBot ? `${BOT_EMOJI[info.bot_id ?? ''] ?? '♟️'} ${info.bot_name ?? 'Бот'}` : 'Два игрока за одним экраном';
  const names: Record<Side, string> = isBot
    ? { [me]: playerName, [me === 'white' ? 'black' : 'white']: opponent } as Record<Side, string>
    : { white: 'Белые', black: 'Чёрные' };

  const wrap = document.createElement('div');
  wrap.className = 'watch';
  wrap.innerHTML = `
    <div class="watch-card">
      <div class="watch-head">
        <div class="watch-title">
          <span class="live-dot"></span>
          <div><b>${esc(playerName)}</b><small>${isBot ? `против ${esc(opponent)}` : esc(opponent)}${info.chess960 ? ' · 960' : ''}${info.time_control && info.time_control !== 'Без часов' ? ` · ⏱ ${esc(info.time_control.replace(/\s*\(.*\)/, ''))}` : ''}</small></div>
        </div>
        <button class="icon-btn watch-close" aria-label="Закрыть">✕</button>
      </div>
      <div class="watch-player top"><span class="pname"></span><span class="pclock"></span></div>
      <div class="watch-board"></div>
      <div class="watch-player bottom"><span class="pname"></span><span class="pclock"></span></div>
      <div class="watch-status"></div>
      <div class="watch-moves"></div>
      <div class="watch-foot"></div>
    </div>`;
  document.body.append(wrap);
  document.body.classList.add('no-scroll');

  const q = <T extends HTMLElement>(sel: string) => wrap.querySelector(sel) as T;
  const top: Side = me === 'white' ? 'black' : 'white';
  q('.watch-player.top .pname').textContent = names[top];
  q('.watch-player.bottom .pname').textContent = names[me];

  const cg: Api = Chessground(q('.watch-board'), {
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    orientation: me,
    viewOnly: true,
    coordinates: true,
    animation: { enabled: true, duration: 200 },
    drawable: { enabled: false },
  });

  let snap: Snap | null = null;
  let result: Result | null = null;
  let polls = 0;
  let closed = false;
  let timer = 0;

  const turnOf = (fen: string): Side => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

  function clockOf(c: Side): number | null {
    if (!snap) return null;
    const v = c === 'white' ? snap.clock_white : snap.clock_black;
    if (v == null) return null;
    // Часы идут у стороны, чей ход, — с момента последнего хода (после первых ходов обеих сторон).
    if (!result && snap.ply >= 2 && turnOf(snap.fen) === c) return v - Math.max(0, Date.now() - Date.parse(snap.ts));
    return v;
  }

  function drawClocks(): void {
    for (const [cls, side] of [['top', top], ['bottom', me]] as const) {
      const el = q(`.watch-player.${cls}`);
      const ms = clockOf(side);
      el.querySelector('.pclock')!.textContent = ms == null ? '' : fmtClock(ms);
      el.classList.toggle('active', !!snap && !result && turnOf(snap.fen) === side);
      el.classList.toggle('low', ms != null && ms < 20_000);
    }
    const foot = q('.watch-foot');
    if (snap && !result) {
      const ago = Math.round((Date.now() - Date.parse(snap.ts)) / 1000);
      foot.textContent = ago < 5 ? 'обновлено только что' : ago < 120 ? `последний ход ${ago} с назад` : `последний ход ${Math.round(ago / 60)} мин назад — возможно, игрок ушёл`;
    }
  }

  function drawStatus(): void {
    const st = q('.watch-status');
    if (result) {
      const text =
        result.result === 'win' ? `🏆 победа — ${esc(playerName)}`
        : result.result === 'loss' ? `победа — ${isBot ? esc(opponent) : 'соперник'}`
        : result.result === 'draw' ? '🤝 ничья'
        : result.result === 'white' ? 'белые победили' : 'чёрные победили';
      st.innerHTML = `<b>Партия окончена: ${text}</b>${result.reason ? ` <span>· ${esc(result.reason)}</span>` : ''}`;
      st.className = `watch-status over ${result.result === 'win' ? 'win' : result.result === 'loss' ? 'loss' : ''}`;
      q('.live-dot').classList.add('off');
      q('.watch-foot').textContent = '';
      return;
    }
    if (!snap) {
      st.textContent = 'Загружаю партию…';
      return;
    }
    const t = turnOf(snap.fen);
    const check = (() => {
      try {
        return posFromFen(snap.fen).isCheck();
      } catch {
        return false;
      }
    })();
    st.className = 'watch-status';
    st.textContent = `${isBot ? (t === me ? `Ход: ${playerName}` : `${info.bot_name ?? 'Бот'} думает…`) : `Ход ${t === 'white' ? 'белых' : 'чёрных'}`}${check ? ' — шах!' : ''}`;
  }

  function drawMoves(): void {
    const box = q('.watch-moves');
    const sans = snap?.sans ? snap.sans.split(' ') : [];
    if (!sans.length) {
      box.textContent = 'Ходов пока нет';
      return;
    }
    const parts: string[] = [];
    for (let i = 0; i < sans.length; i += 2)
      parts.push(`<span class="mv"><i>${i / 2 + 1}.</i>${esc(sans[i])}${sans[i + 1] ? ` ${esc(sans[i + 1])}` : ''}</span>`);
    box.innerHTML = parts.join(' ');
    box.scrollLeft = box.scrollWidth;
  }

  function apply(s: Snap): void {
    snap = s;
    let check = false;
    try {
      check = posFromFen(s.fen).isCheck();
    } catch {
      /* битая позиция — просто без подсветки шаха */
    }
    const lm = s.last_uci && s.last_uci.length >= 4 ? ([s.last_uci.slice(0, 2), s.last_uci.slice(2, 4)] as Key[]) : undefined;
    cg.set({ fen: s.fen.split(' ')[0], turnColor: turnOf(s.fen), lastMove: lm, check: check ? turnOf(s.fen) : false });
    drawMoves();
    drawStatus();
    drawClocks();
  }

  async function poll(): Promise<void> {
    if (closed) return;
    try {
      const res = await api(`cc_moves?game_id=eq.${game.game_id}&order=id.desc&limit=1&select=id,ts,ply,fen,last_uci,sans,clock_white,clock_black`);
      const rows = (await res.json().catch(() => [])) as Snap[];
      if (res.ok && rows[0] && rows[0].id !== snap?.id) apply(rows[0]);
      if (!result && polls++ % RESULT_EVERY === 0) {
        const r = await api(`cc_games?id=eq.${game.game_id}&select=result,how,reason`);
        const rr = (await r.json().catch(() => [])) as Result[];
        if (r.ok && rr[0]) {
          result = rr[0];
          drawStatus();
          drawClocks();
        }
      }
    } catch {
      /* сеть моргнула — попробуем на следующем круге */
    }
    if (!closed && !result) timer = window.setTimeout(() => void poll(), POLL_MS);
  }

  const tick = window.setInterval(() => !closed && drawClocks(), 200);
  drawStatus();
  void poll();

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(tick);
    cg.destroy();
    wrap.remove();
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  q('.watch-close').onclick = close;
  wrap.onclick = (e) => e.target === wrap && close();
  return close;
}

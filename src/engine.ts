// Обёртка над Stockfish (UCI) в Web Worker. Запросы идут по очереди; cancel() отменяет всё начатое.

export interface Line {
  multipv: number;
  depth: number;
  /** Оценка в сантипешках с точки зрения белых; мат переведён в большое число. */
  cp: number;
  /** Мат в N ходов с точки зрения белых (знак — кто матует). */
  mate?: number;
  pv: string[];
}

export interface Result {
  bestmove: string;
  lines: Line[];
}

export interface Options {
  depth?: number;
  movetime?: number;
  multipv?: number;
  /** Сила игры 0–20; 20 — полная. */
  skill?: number;
  /** Шахматы Фишера: рокировка в записи — «король бьёт свою ладью» (e1h1). */
  chess960?: boolean;
}

const MATE_CP = 10000;

const WASM_ENGINE = 'engine/wasm-worker.js#stockfish-19-lite-single.wasm';
/** Без WebAssembly: медленнее в несколько раз, зато работает в любом браузере. */
const ASM_ENGINE = 'engine/stockfish-19-asm.js';
/** Сколько ждём ответа wasm-движка, прежде чем перейти на запасной (wasm 1,8 МБ на медленном интернете). */
const WASM_TIMEOUT_MS = 25_000;
/** Анализ «на глубину» (оценка тренера) не дольше этого: на медленном телефоне глубина 12 может идти минуту. */
const DEPTH_TIME_CAP_MS = { wasm: 4000, asm: 2500 };
/** Если движок не ответил за время расчёта плюс столько — считаем, что он завис или его остановил браузер. */
const STALL_MS = { wasm: 5000, asm: 12000 };

/** Умеет ли браузер WebAssembly с SIMD — без него wasm-сборка Stockfish не запустится. */
function wasmSimdSupported(): boolean {
  try {
    // (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt)
    return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

function forcedAsm(): boolean {
  try {
    return new URLSearchParams(location.search).get('engine') === 'asm' || localStorage.getItem('chesscoach.engine') === 'asm';
  } catch {
    return false;
  }
}

export class Engine {
  private worker!: Worker;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private onLine: ((line: string) => void) | null = null;
  private generation = 0;
  private stalls = 0;
  /** Какая сборка работает: wasm — обычная, asm — запасная без WebAssembly. */
  kind: 'wasm' | 'asm' = 'wasm';
  /** Готов ли движок (false — загружается или перезапускается после зависания). */
  isReady = false;
  /** Вызывается, когда меняется isReady, — чтобы интерфейс показал «Загружаю движок…». */
  onStatus: (() => void) | null = null;

  constructor() {
    this.ready = this.boot(false);
  }

  private setReady(v: boolean): void {
    this.isReady = v;
    this.onStatus?.();
  }

  private spawn(path: string, onFail: () => void): void {
    this.worker?.terminate();
    this.worker = new Worker(new URL(path, document.baseURI));
    this.worker.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      // Движок не смог запуститься (нет нужных возможностей WebAssembly, не хватило памяти).
      if (/^(Aborted\(|RuntimeError|CompileError|LinkError)|both async and sync fetching of the wasm failed/.test(ev.data)) onFail();
      this.onLine?.(ev.data);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      onFail();
    };
  }

  private async boot(asmOnly: boolean): Promise<void> {
    this.setReady(false);
    if (!asmOnly && wasmSimdSupported() && !forcedAsm()) {
      this.kind = 'wasm';
      const ok = await new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (v: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => finish(false), WASM_TIMEOUT_MS);
        this.spawn(WASM_ENGINE, () => finish(false));
        this.handshake().then(() => finish(true));
      });
      if (ok) return this.setReady(true);
      console.warn('Stockfish wasm не запустился — переключаюсь на запасную сборку без WebAssembly');
    }
    this.kind = 'asm';
    this.onLine = null;
    this.spawn(ASM_ENGINE, () => undefined);
    await this.handshake();
    this.setReady(true);
  }

  /** Движок завис или его остановил браузер: перезапуск, со второго раза — запасная сборка. */
  private restart(): Promise<void> {
    this.stalls++;
    console.warn(`Stockfish не отвечает — перезапуск (${this.stalls})`);
    this.onLine = null;
    this.ready = this.boot(this.kind === 'asm' || this.stalls >= 2);
    return this.ready;
  }

  private async handshake(): Promise<void> {
    await this.command('uci', 'uciok');
    await this.command('isready', 'readyok');
  }

  private command(cmd: string, waitFor: string): Promise<void> {
    return new Promise((resolve) => {
      this.onLine = (line) => {
        if (line.startsWith(waitFor)) {
          this.onLine = null;
          resolve();
        }
      };
      this.worker.postMessage(cmd);
    });
  }

  /** Движок готов к работе (после возможного перехода на запасную сборку). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Отменяет текущий и все ожидающие расчёты: их промисы вернут null. */
  cancel(): void {
    this.generation++;
    this.worker.postMessage('stop');
  }

  analyse(fen: string, opts: Options, onUpdate?: (lines: Line[]) => void): Promise<Result | null> {
    const gen = this.generation;
    const run = async (): Promise<Result | null> => {
      await this.ready;
      if (gen !== this.generation) return null;
      const whiteToMove = fen.split(' ')[1] !== 'b';
      const lines = new Map<number, Line>();
      const sorted = () => [...lines.values()].sort((a, b) => a.multipv - b.multipv);
      const go = (): Promise<string | null> => {
        lines.clear();
        this.worker.postMessage(`setoption name MultiPV value ${opts.multipv ?? 1}`);
        this.worker.postMessage(`setoption name Skill Level value ${opts.skill ?? 20}`);
        this.worker.postMessage(`setoption name UCI_Chess960 value ${opts.chess960 ? 'true' : 'false'}`);
        this.worker.postMessage(`position fen ${fen}`);
        const cap = DEPTH_TIME_CAP_MS[this.kind];
        const limit = (opts.movetime ?? cap) + STALL_MS[this.kind];
        return new Promise<string | null>((resolve) => {
          const watchdog = setTimeout(() => {
            this.onLine = null;
            resolve(null);
          }, limit);
          this.onLine = (line) => {
            if (line.startsWith('info ')) {
              const parsed = parseInfo(line, whiteToMove);
              if (parsed) {
                lines.set(parsed.multipv, parsed);
                onUpdate?.(sorted());
              }
            } else if (line.startsWith('bestmove')) {
              clearTimeout(watchdog);
              this.onLine = null;
              resolve(line.split(' ')[1] ?? '');
            }
          };
          this.worker.postMessage(opts.movetime ? `go movetime ${opts.movetime}` : `go depth ${opts.depth ?? 12} movetime ${cap}`);
        });
      };
      let bestmove = await go();
      // Зависание: перезапускаем движок и считаем заново (до двух раз).
      for (let i = 0; bestmove === null && i < 2; i++) {
        await this.restart();
        if (gen !== this.generation) return null;
        bestmove = await go();
      }
      if (bestmove === null) return null;
      if (gen !== this.generation) return null;
      return { bestmove, lines: sorted() };
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }
}

function parseInfo(line: string, whiteToMove: boolean): Line | null {
  if (line.includes('upperbound') || line.includes('lowerbound')) return null;
  const t = line.split(' ');
  const pvAt = t.indexOf('pv');
  const scoreAt = t.indexOf('score');
  if (pvAt < 0 || scoreAt < 0) return null;
  const num = (key: string) => {
    const i = t.indexOf(key);
    return i < 0 ? undefined : Number(t[i + 1]);
  };
  const sign = whiteToMove ? 1 : -1;
  const value = Number(t[scoreAt + 2]);
  let cp: number;
  let mate: number | undefined;
  if (t[scoreAt + 1] === 'mate') {
    mate = sign * value;
    cp = Math.sign(mate) * (MATE_CP - Math.abs(mate) * 10);
  } else {
    cp = sign * value;
  }
  return { multipv: num('multipv') ?? 1, depth: num('depth') ?? 0, cp, mate, pv: t.slice(pvAt + 1) };
}

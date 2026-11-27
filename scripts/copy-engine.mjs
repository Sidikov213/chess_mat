// Копирует Stockfish в public/engine: wasm (однопоточная lite-сборка) и запасную asm.js-сборку
// для браузеров без WebAssembly SIMD (старые iPhone, режим блокировки iOS).
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish', 'bin');
const dst = join(root, 'public', 'engine');
mkdirSync(dst, { recursive: true });
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'stockfish-19-asm.js']) {
  cpSync(join(src, f), join(dst, f));
}

// Обёртка для wasm-сборки: если движок не смог запуститься (нет нужных возможностей WebAssembly,
// не скачался .wasm, не хватило памяти), ошибка внутри воркера иначе пропадает молча — а так игра
// сразу узнаёт о ней и переходит на запасную сборку. Путь к .wasm движок берёт из #хэша адреса.
writeFileSync(
  join(dst, 'wasm-worker.js'),
  `self.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  postMessage('Aborted(' + (r && r.message ? r.message : String(r)) + ')');
});
importScripts('stockfish-19-lite-single.js');
`,
);

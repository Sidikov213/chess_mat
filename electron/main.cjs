// Окно приложения. Файлы отдаются по своей схеме app://, чтобы движок (Web Worker + wasm) грузился как с обычного сайта.
const { app, BrowserWindow, protocol, net, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const netRelay = require('./net.cjs');

// Голос тренера: постоянный процесс PowerShell с синтезатором Windows (голос Pavel), см. tts.ps1.
let tts = null;
const waiting = [];
function ttsProc() {
  if (tts || process.platform !== 'win32') return tts;
  tts = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tts.ps1')], {
    windowsHide: true,
  });
  let buf = '';
  tts.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && !line.startsWith('READY')) waiting.shift()?.(line);
    }
  });
  tts.on('exit', () => {
    tts = null;
    waiting.splice(0).forEach((cb) => cb('ERR exit'));
  });
  return tts;
}
ipcMain.handle('tts', (_e, text) => {
  const proc = ttsProc();
  if (!proc) return null;
  return new Promise((resolve) => {
    waiting.push((line) => {
      if (line.startsWith('ERR')) return resolve(null);
      try {
        resolve(fs.readFileSync(line).toString('base64'));
      } catch {
        resolve(null);
      }
    });
    proc.stdin.write(Buffer.from(String(text), 'utf8').toString('base64') + '\n');
  });
});
app.on('will-quit', () => {
  tts?.kill();
  netRelay.closeAll();
});

const DIST = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    autoHideMenuBar: true,
    title: 'Chess Coach',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  ttsProc(); // прогрев, чтобы первая реплика не ждала запуска PowerShell
  netRelay.setup(ipcMain, (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://local/index.html');
});

app.on('window-all-closed', () => app.quit());

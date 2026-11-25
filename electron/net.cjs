// Игра по сети без сервера и без зависимостей: одно приложение — хозяин (HTTP-сервер на порту NET_PORT),
// второе подключается к нему по адресу в локальной сети. Сервер только пересылает события партии
// (ход, сдача, ничья, реванш); правила проверяет каждая сторона сама (chessops в окне приложения).
//
// Почему сеть живёт в главном процессе, а не в окне: окно открыто по защищённой схеме app://, и браузер
// запретил бы ему запросы на http://192.168.x.x (смешанное содержимое). Главному процессу Node это можно.
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const NET_PORT = 47615;

let server = null; // наш сервер, когда мы хозяин
let room = null; // { hostColor, tc, hostName, guestToken, guestName, events: [] }
const streams = new Set(); // открытые потоки событий гостей (SSE)
let guest = null; // { base, token, req } — когда мы гость
let emit = () => {}; // (channel, payload) → окно

/** Адреса компьютера в локальной сети. Виртуальные адаптеры (WSL, Hyper-V, VirtualBox, VMware) отбрасываем —
 *  другу к ним не подключиться; домашние 192.168.* — первыми. */
function lanAddresses() {
  // Radmin VPN, Hamachi, ZeroTier, Tailscale не отбрасываем: через них друзья играют по интернету как в одной сети.
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Docker|vboxnet|xray|v2ray|wintun|happ|outline|proxy/i;
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list || []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, address: i.address })),
  );
  const real = all.filter((i) => !virtual.test(i.name));
  const rank = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2);
  return (real.length ? real : all).map((i) => i.address).sort((a, b) => rank(a) - rank(b));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Событие в комнату: всем гостям в поток и в своё окно. */
function push(from, type, data) {
  if (!room) return;
  const ev = { seq: room.events.length + 1, from, type, data: data ?? null, ts: Date.now() };
  room.events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of streams) res.write(line);
  emit('net:event', ev);
}

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if (!room) return reply(res, 404, { error: 'no_game' });

  if (req.method === 'GET' && url.pathname === '/ping') return reply(res, 200, { ok: true, app: 'chess-coach' });

  if (req.method === 'POST' && url.pathname === '/join') {
    return void readJson(req).then((body) => {
      if (room.guestToken && body.token !== room.guestToken) return reply(res, 409, { error: 'busy' });
      const rejoin = !!room.guestToken;
      room.guestToken ??= crypto.randomBytes(16).toString('hex');
      room.guestName = String(body.name || 'Гость').slice(0, 20);
      reply(res, 200, {
        token: room.guestToken, hostColor: room.hostColor, tc: room.tc, startFen: room.startFen, hostName: room.hostName,
        events: room.events,
      });
      if (!rejoin) push('guest', 'joined', { name: room.guestName });
    });
  }

  if (token !== room.guestToken) return reply(res, 403, { error: 'bad_token' });

  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    streams.add(res);
    const keep = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keep);
      streams.delete(res);
      if (room && streams.size === 0) push('guest', 'left', null);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    return void readJson(req).then((body) => {
      push('guest', String(body.type || ''), body.data);
      reply(res, 200, { ok: true });
    });
  }

  reply(res, 404, { error: 'not_found' });
}

function closeHost() {
  for (const res of streams) res.end();
  streams.clear();
  server?.close();
  server = null;
  room = null;
}

function closeGuest() {
  guest?.req?.destroy();
  guest = null;
}

function request(method, base, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      `${base}${path}`,
      { method, timeout: 5000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text || '{}') });
          } catch {
            resolve({ status: res.statusCode, body: {} });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Поток событий от хозяина: читаем SSE построчно и отдаём в окно. */
function openStream() {
  const g = guest;
  const req = http.get(`${g.base}/stream?token=${g.token}`, (res) => {
    if (res.statusCode !== 200) {
      emit('net:status', { connected: false, reason: 'Хозяин не пустил в игру' });
      return;
    }
    emit('net:status', { connected: true });
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            emit('net:event', JSON.parse(line.slice(6)));
          } catch {
            /* битое событие — пропускаем */
          }
        }
      }
    });
    res.on('end', () => {
      if (guest === g) emit('net:status', { connected: false, reason: 'Соединение с хозяином потеряно' });
    });
  });
  req.on('error', () => {
    if (guest === g) emit('net:status', { connected: false, reason: 'Соединение с хозяином потеряно' });
  });
  g.req = req;
}

function setup(ipcMain, sendToWindow) {
  emit = sendToWindow;

  ipcMain.handle('net:host', (_e, opts) => {
    closeGuest();
    closeHost();
    room = {
      hostColor: opts.hostColor, tc: opts.tc, startFen: opts.startFen || null,
      hostName: String(opts.name || 'Хозяин').slice(0, 20), guestToken: null, events: [],
    };
    return new Promise((resolve) => {
      server = http.createServer(handle);
      server.on('error', (err) => {
        const busy = err.code === 'EADDRINUSE';
        closeHost();
        resolve({ ok: false, error: busy ? `Порт ${NET_PORT} занят: игра уже создана в другом окне?` : String(err.message) });
      });
      server.listen(NET_PORT, '0.0.0.0', () => resolve({ ok: true, addresses: lanAddresses(), port: NET_PORT }));
    });
  });

  ipcMain.handle('net:join', async (_e, { addr, name }) => {
    closeHost();
    closeGuest();
    const clean = String(addr || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!clean) return { ok: false, error: 'Введите код друга' };
    const base = `http://${clean.includes(':') ? clean : `${clean}:${NET_PORT}`}`;
    try {
      const r = await request('POST', base, '/join', { name });
      if (r.status === 409) return { ok: false, error: 'В этой игре уже есть второй игрок' };
      if (r.status === 404) return { ok: false, error: 'По этому адресу игра не создана' };
      if (r.status !== 200) return { ok: false, error: `Ошибка подключения (${r.status})` };
      guest = { base, token: r.body.token, req: null };
      openStream();
      return { ok: true, ...r.body };
    } catch (err) {
      return { ok: false, error: `Не удалось подключиться к ${clean}: ${err.code === 'ECONNREFUSED' ? 'там не создана игра' : err.code || err.message}` };
    }
  });

  ipcMain.handle('net:send', async (_e, { type, data }) => {
    if (room) {
      push('host', type, data);
      return { ok: true };
    }
    if (guest) {
      try {
        const r = await request('POST', guest.base, `/event?token=${guest.token}`, { type, data });
        return { ok: r.status === 200 };
      } catch {
        return { ok: false };
      }
    }
    return { ok: false };
  });

  /** Хозяин меняет настройки реванша (цвет, контроль) — гостю они приходят событием. */
  ipcMain.handle('net:update', (_e, opts) => {
    if (room) Object.assign(room, opts);
  });

  ipcMain.handle('net:leave', () => {
    if (room) push('host', 'left', null);
    closeHost();
    closeGuest();
  });
}

module.exports = { setup, closeAll: () => (closeHost(), closeGuest()) };

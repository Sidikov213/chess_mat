// Мост для страницы: озвучка реплик тренера голосом Windows (Pavel) и игра по сети.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coachVoice', {
  /** Возвращает WAV в base64 или null, если синтез недоступен. */
  synth: (text) => ipcRenderer.invoke('tts', text),
});

contextBridge.exposeInMainWorld('coachNet', {
  host: (opts) => ipcRenderer.invoke('net:host', opts),
  join: (addr, name) => ipcRenderer.invoke('net:join', { addr, name }),
  send: (type, data) => ipcRenderer.invoke('net:send', { type, data }),
  update: (opts) => ipcRenderer.invoke('net:update', opts),
  leave: () => ipcRenderer.invoke('net:leave'),
  onEvent: (cb) => ipcRenderer.on('net:event', (_e, ev) => cb(ev)),
  onStatus: (cb) => ipcRenderer.on('net:status', (_e, st) => cb(st)),
});

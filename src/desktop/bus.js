/**
 * Cross-window message bus.
 *
 * BroadcastChannel carries everything that changes rarely (track loaded, analysis,
 * device lists, commands). The per-frame numbers travel through the SharedArrayBuffer
 * instead, which is handed to each panel window over the opener relationship.
 */

const CHANNEL = 'nexus3';
export const HELLO = 'nx3:hello';
export const WELCOME = 'nx3:welcome';

export class Bus {
  constructor(from) {
    this.from = from;
    this.handlers = new Map();
    this.bc = new BroadcastChannel(CHANNEL);
    this.bc.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.from === this.from) return;
      for (const fn of this.handlers.get(msg.type) ?? []) fn(msg.data, msg);
    };
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  send(type, data) {
    this.bc.postMessage({ type, data, from: this.from });
  }

  close() {
    this.handlers.clear();
    this.bc.close();
  }
}

/** Console side: hand the shared buffer and a cold snapshot to each panel window. */
export function serveWelcome(buildWelcome) {
  const onMessage = (event) => {
    if (event.data?.type !== HELLO || !event.source) return;
    if (event.origin !== location.origin) return;
    event.source.postMessage({ type: WELCOME, ...buildWelcome(event.data.panel) }, location.origin);
  };
  addEventListener('message', onMessage);
  return () => removeEventListener('message', onMessage);
}

/** Panel side: ask the console window for the shared buffer. */
export function requestWelcome(panel, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!window.opener) return reject(new Error('panel window has no console window to attach to'));

    const onMessage = (event) => {
      if (event.origin !== location.origin || event.data?.type !== WELCOME) return;
      cleanup();
      resolve(event.data);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('the console window did not answer'));
    }, timeoutMs);
    const retry = setInterval(ask, 400);
    function cleanup() {
      clearTimeout(timer);
      clearInterval(retry);
      removeEventListener('message', onMessage);
    }
    function ask() {
      window.opener.postMessage({ type: HELLO, panel }, location.origin);
    }

    addEventListener('message', onMessage);
    ask();
  });
}

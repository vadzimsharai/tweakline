import { WebSocketServer } from 'ws';
import { isPlainObject } from '../protocol.mjs';
import { check } from './checks.mjs';
import { cleanDeviceName } from './pairing.mjs';

const SOCKET_PATH = '/ext';
const HELLO_TIMEOUT_MS = 5000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_HELLO_BYTES = 4 * 1024;
export const MAX_UNAUTHENTICATED_SOCKETS = 32;
const BUSY_RESPONSE = 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
export const CLOSE_CODES = {
  internalError: 1011,
  helloTimeout: 4001,
  badMessage: 4002,
  unauthorized: 4003,
  replaced: 4004,
  badHello: 4005,
};

// ws has no public way to change the limit of one socket, and a stranger must not get 16 MB buffered before hello.
function allowLargeMessages(ws) {
  if (!ws._receiver) throw new Error('ws receiver not found: cannot raise the message limit after hello');
  ws._receiver._maxPayload = MAX_MESSAGE_BYTES;
}

// The extension's socket: a hello with the device token, then calls from the browser and replies to `do`.
export function attachBrowserSocket(server, { store, credentials, browsers, methods }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_HELLO_BYTES });
  let unauthenticated = 0;
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== SOCKET_PATH) { socket.destroy(); return; }
    if (unauthenticated >= MAX_UNAUTHENTICATED_SOCKETS) { socket.end(BUSY_RESPONSE); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  function greet(ws, msg) {
    if (msg.type !== 'hello') { ws.close(CLOSE_CODES.badHello, 'bad hello'); return null; }
    const device = credentials.deviceByToken(msg.deviceToken);
    if (!device) { ws.close(CLOSE_CODES.unauthorized, 'unauthorized'); return null; }
    const name = cleanDeviceName(msg.name) || device.name;
    if (name !== device.name) {
      credentials.renameDevice(device.id, name);
      store.renameDevice(device.id, name);
    }
    browsers.get(device.id)?.ws.close(CLOSE_CODES.replaced, 'replaced');
    const browser = { id: device.id, name, ws };
    allowLargeMessages(ws);
    browsers.connect(browser);
    browsers.send(browser, { type: 'ready' });
    return browser;
  }

  function answerCall(browser, msg) {
    const reply = (body) => browsers.send(browser, { type: 'reply', id: msg.id, ...body });
    try {
      if (typeof msg.method !== 'string' || !Object.hasOwn(methods, msg.method)) throw new Error(`unknown method ${String(msg.method)}`);
      check(msg.params === undefined || isPlainObject(msg.params), 'params must be an object');
      reply({ ok: true, data: methods[msg.method](browser, msg.params ?? {}) });
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  }

  wss.on('connection', (ws) => {
    let browser = null;
    let counted = true;
    unauthenticated += 1;
    const uncount = () => {
      if (counted) unauthenticated -= 1;
      counted = false;
    };
    const helloTimer = setTimeout(() => ws.close(CLOSE_CODES.helloTimeout, 'hello timeout'), HELLO_TIMEOUT_MS);

    function handleMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(CLOSE_CODES.badMessage, 'bad json'); return; }
      if (!isPlainObject(msg)) { ws.close(CLOSE_CODES.badMessage, 'bad message'); return; }
      if (!browser) {
        browser = greet(ws, msg);
        if (browser) {
          clearTimeout(helloTimer);
          uncount();
        }
        return;
      }
      if (!credentials.deviceExists(browser.id)) { ws.close(CLOSE_CODES.unauthorized, 'unauthorized'); return; }
      if (msg.type === 'done') browsers.completeDo(browser, msg);
      else if (msg.type === 'call') answerCall(browser, msg);
    }

    ws.on('message', (raw) => {
      try {
        handleMessage(raw);
      } catch (error) {
        console.error(error);
        ws.close(CLOSE_CODES.internalError, 'internal error');
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      uncount();
      if (browser) browsers.disconnect(browser);
    });
    ws.on('error', () => {});
  });

  return {
    terminateAll() {
      for (const client of wss.clients) client.terminate();
    },
  };
}

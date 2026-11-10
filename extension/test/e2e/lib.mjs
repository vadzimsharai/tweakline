import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startRelay } from '../../../relay/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(HERE, '../..');
const RELAY_DOMAIN = 'gate.test';
const OPEN_HOST = 'wg.test';
const ONBOARDING_WAIT_MS = 5000;
const POLL_MS = 50;
export const DEFAULT_AI_STALE_MS = 7000;

export function chromiumPath() {
  const candidate = process.env.CHROMIUM_PATH || chromium.executablePath();
  if (!candidate || !fs.existsSync(candidate)) {
    throw new Error(`Chromium not found${candidate ? ` at ${candidate}` : ''}: run \`npm run e2e:install\` or set CHROMIUM_PATH`);
  }
  return candidate;
}

const WebSocketServer = createRequire(path.join(HERE, '../../../relay/server.mjs'))('ws').WebSocketServer;

async function freePort() {
  const holder = http.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  await new Promise((resolve) => holder.close(resolve));
  return port;
}

// The shipped source is patched by exact text: if a refactor moves that text, the build must stop instead of testing the wrong thing.
function patchSource(out, file, from, to, { all = false } = {}) {
  const target = path.join(out, file);
  const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(from)) throw new Error(`e2e build: ${file} no longer contains ${JSON.stringify(from)}`);
  fs.writeFileSync(target, all ? source.replaceAll(from, to) : source.replace(from, to));
}

// Some Android browsers resolve insertCSS and userScripts.execute without doing anything; the debugger may not attach there either.
const SILENT_INJECTION = `chrome.scripting.insertCSS = async () => {};
chrome.scripting.removeCSS = async () => {};
if (chrome.userScripts) chrome.userScripts.execute = async () => [{ result: null, frameId: 0 }];
chrome.debugger.attach = async () => { throw new Error('Cannot attach to this target'); };
`;

export function buildExtension(localPort, aiStaleMs = DEFAULT_AI_STALE_MS, { silentInjection = false } = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ext-'));
  fs.cpSync(EXTENSION, out, { recursive: true, filter: (p) => !p.includes(`${path.sep}test`) && !p.includes(`${path.sep}node_modules`) });
  // Tests need to see inside the UI; shipped builds keep the shadow roots closed.
  for (const file of ['ui/core.js', 'ui/notes.js']) patchSource(out, file, "mode: 'closed'", "mode: 'open'", { all: true });
  // A real server on the default port of this machine must not leak into the test.
  patchSource(out, 'lib/servers.js', 'const DEFAULT_PORT = 8787;', `const DEFAULT_PORT = ${localPort};`);
  // The real 90 seconds would make the stale line untestable.
  patchSource(out, 'ui/chat.js', 'const AI_STALE_MS = 90000;', `const AI_STALE_MS = ${aiStaleMs};`);
  if (silentInjection) {
    const background = path.join(out, 'background.js');
    fs.writeFileSync(background, SILENT_INJECTION + fs.readFileSync(background, 'utf8'));
  }
  return out;
}

async function findOnboarding(context) {
  const deadline = Date.now() + ONBOARDING_WAIT_MS;
  while (Date.now() < deadline) {
    const found = context.pages().find((p) => p.url().endsWith('/onboarding.html'));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

async function startExtraRelay(host = '127.0.0.1') {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-data-'));
  const relay = await startRelay({ port, dataDir, version: 'e2e' });
  const base = `http://${host}:${port}`;
  return { base, host: `${host}:${port}`, pairLink: () => `${base}/pair#${relay.createPairCode()}`, stop: () => relay.close() };
}

// A paired server that misbehaves: it can send anything down the socket.
export async function startFakeServer() {
  const token = 'f'.repeat(64);
  const sockets = new Set();
  const pending = new Map();
  let listAnswer = [];
  let silent = false;
  let refuseHello = false;
  let hellos = 0;
  let pairings = 0;
  const calls = [];
  const answers = new Map();
  const failing = new Set();
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/tweakline') return res.end(JSON.stringify({ name: 'tweakline', version: 'fake', addresses: [] }));
    if (req.url === '/pair') return res.end(JSON.stringify({ deviceToken: token, deviceId: `fake-${++pairings}`, addresses: [] }));
    res.writeHead(404);
    res.end('{}');
  });
  const wss = new WebSocketServer({ server, path: '/ext' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        hellos += 1;
        if (refuseHello) ws.close(4003, 'unauthorized'); else ws.send(JSON.stringify({ type: 'ready' }));
      }
      if (msg.type === 'call') calls.push(msg.method);
      if (msg.type === 'call' && !silent && failing.has(msg.method)) ws.send(JSON.stringify({ type: 'reply', id: msg.id, ok: false, error: 'refused' }));
      else if (msg.type === 'call' && !silent) ws.send(JSON.stringify({ type: 'reply', id: msg.id, ok: true, data: msg.method === 'session.list' ? listAnswer : answers.get(msg.method) ?? [] }));
      if (msg.type === 'done') pending.get(msg.id)?.(msg);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pairLink: `${base}/pair#anything`,
    setSessions: (rows) => { listAnswer = rows; },
    setSilent: (on) => { silent = on; },
    setFailing: (method) => { failing.add(method); },
    hellos: () => hellos,
    calls: () => [...calls],
    setAnswer: (method, data) => { answers.set(method, data); },
    revokeDevice: () => {
      refuseHello = true;
      for (const ws of sockets) ws.close(4003, 'unauthorized');
    },
    send: (message) => { for (const ws of sockets) ws.send(JSON.stringify(message)); },
    forge: (session, op, args = {}) => new Promise((resolve) => {
      const id = `forged-${Date.now()}`;
      pending.set(id, resolve);
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'do', id, session, op, args, tab: null }));
    }),
    stop: () => new Promise((resolve) => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

// Pairs like a server but never upgrades the socket, like a proxy that drops WebSocket upgrades.
export async function startNoSocketServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/tweakline') return res.end(JSON.stringify({ name: 'tweakline', version: 'fake', addresses: [] }));
    if (req.url === '/pair') return res.end(JSON.stringify({ deviceToken: 'n'.repeat(64), deviceId: 'nosocket', addresses: [] }));
    res.writeHead(404);
    res.end('{}');
  });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, pairLink: `${base}/pair#anything`, stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function startWorld({ width = 724, height = 784, aiStaleMs = DEFAULT_AI_STALE_MS, silentInjection = false } = {}) {
  const pagesDir = path.join(HERE, 'pages');
  const site = http.createServer((req, res) => {
    const name = (req.url.split('?')[0].replace(/^\//, '') || 'plain') + '.html';
    const file = path.join(pagesDir, path.basename(name));
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (name === 'csp.html') headers['content-security-policy'] = "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'";
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => site.listen(0, resolve));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-data-'));
  const relayPort = await freePort();
  const relayBase = `http://127.0.0.1:${relayPort}`;
  const relayOptions = { port: relayPort, dataDir, domain: RELAY_DOMAIN, version: 'e2e' };
  let relay = await startRelay(relayOptions);
  const extension = buildExtension(relayPort, aiStaleMs, { silentInjection });
  const context = await chromium.launchPersistentContext('', {
    executablePath: chromiumPath(), headless: false,
    args: ['--headless=new', '--no-sandbox', `--host-resolver-rules=MAP ${OPEN_HOST} 127.0.0.1`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width, height }, hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'],
  });
  const siteBase = `http://127.0.0.1:${site.address().port}`;
  const onboarding = await findOnboarding(context);
  const page = context.pages().find((p) => p !== onboarding) || await context.newPage();
  const errors = [];
  context.on('weberror', (e) => errors.push(String(e.error())));
  page.on('console', (m) => { if (m.text().startsWith('Tweakline')) errors.push(m.text()); });
  const cdp = await context.newCDPSession(page);
  const restartRelay = async (overrides = {}) => {
    await relay.close();
    relay = await startRelay({ ...relayOptions, ...overrides });
  };
  const extras = [];
  const addRelay = async (host) => {
    const extra = await startExtraRelay(host);
    extras.push(extra);
    return extra;
  };
  const close = async () => {
    await context.close();
    await relay.close();
    await Promise.allSettled(extras.map((extra) => extra.stop()));
    site.close();
  };
  return { context, page, cdp, onboarding, siteBase, relayBase, publicBase: `https://${RELAY_DOMAIN}`, openHost: OPEN_HOST, errors, width, height, restartRelay, addRelay, pairLink: () => `${relayBase}/pair#${relay.createPairCode()}`, close };
}

export function driver(world) {
  const { page, cdp } = world;
  const box = (s) => page.locator(s).first().boundingBox();
  const vis = (s) => page.locator(s).first().isVisible();
  const touchAt = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(110);
  };
  return {
    box, vis, touchAt,
    wait: (ms = 120) => page.waitForTimeout(ms),
    tap: async (s) => {
      const l = page.locator(s).first();
      await l.waitFor({ state: 'visible', timeout: 5000 });
      const b = await l.boundingBox();
      await touchAt(b.x + b.width / 2, b.y + b.height / 2);
    },
    swipe: async (x0, y0, x1, y1, steps = 8) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let i = 1; i <= steps; i += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(280);
    },
    down: (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }),
    move: (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }),
    up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    cls: (s) => page.locator(s).first().evaluate((e) => e.className),
    text: (s) => page.locator(s).first().textContent(),
    count: (s) => page.locator(s).count(),
  };
}

export const aiClient = (url) => {
  const post = async (p, body) => (await fetch(url + p, { method: 'POST', body: JSON.stringify(body) })).json();
  return {
    url,
    instructions: () => fetch(url).then((r) => r.text()),
    name: (title, ai) => post('session', { title, ai }),
    say: (text, extra = {}) => post('say', { text, ...extra }),
    act: (op, args = {}, tab) => post('do', { op, args, tab }),
    events: (after = 0, wait = 0) => fetch(`${url}events?after=${after}&wait=${wait}`).then((r) => r.json()),
    file: (id) => fetch(`${url}files/${id}`),
  };
};

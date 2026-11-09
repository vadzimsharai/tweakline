import fs from 'node:fs';
import { handleMcpRequest } from '../mcp.mjs';
import { MAX_FILE_BYTES } from '../protocol.mjs';
import { UnknownChat } from './chats.mjs';
import { BadRequest, MAX_JSON_BYTES, readBody, sendJson, sendText, TooLarge } from './http-io.mjs';
import { baseFor } from './network.mjs';

export const BUNDLE_ROUTE = '/tweakline.js';
const BASE64_BYTES_PER_BINARY_BYTE = 4 / 3;
const MAX_MCP_BYTES = Math.ceil(MAX_FILE_BYTES * BASE64_BYTES_PER_BINARY_BYTE) + MAX_JSON_BYTES;
const MIN_NODE_MAJOR = 22;
const REQUEST_URL_BASE = 'http://relay';
const SESSION_PATH = /^\/s\/([\w-]+)\/?(.*)$/;
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const PAIR_PAGE = 'This is a one-time link that connects a browser to a Tweakline server. Paste it into the extension: open its menu, then "Servers", then "Add server". "Connect AI" offers the same when no server is added yet.\n';

const installScript = (base) => `#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo 'Tweakline needs Node.js ${MIN_NODE_MAJOR} or newer: https://nodejs.org' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= ${MIN_NODE_MAJOR} ? 0 : 1)' || { echo 'Tweakline needs Node.js ${MIN_NODE_MAJOR} or newer' >&2; exit 1; }
dir="\${TWEAKLINE_HOME:-\$HOME/.local/share/tweakline}"
mkdir -p "\$dir"
curl -fsSL '${base}${BUNDLE_ROUTE}' -o "\$dir/tweakline-server.js.tmp"
mv "\$dir/tweakline-server.js.tmp" "\$dir/tweakline-server.js"
exec node "\$dir/tweakline-server.js" "\$@"
`;

function serveBundle(res, bundleFile) {
  const stream = fs.createReadStream(bundleFile);
  stream.once('open', () => {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    stream.pipe(res);
  });
  stream.once('error', (error) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error.code === 'ENOENT') { sendJson(res, 404, { error: 'not found' }); return; }
    console.error(error);
    sendJson(res, 500, { error: 'internal error' });
  });
}

function sendError(req, res, error) {
  if (res.writableEnded) return;
  if (error instanceof TooLarge) {
    if (!req.complete) res.once('finish', () => req.socket.destroy());
    return sendJson(res, 413, { error: error.message || 'too large' }, { connection: 'close' });
  }
  if (error instanceof SyntaxError) return sendJson(res, 400, { error: 'bad json' });
  if (error instanceof BadRequest || error instanceof UnknownChat) return sendJson(res, 400, { error: error.message });
  sendJson(res, 500, { error: 'internal error' });
  console.error(error);
}

export function createHttpHandler({ version, addresses, bundleFile, credentials, aiById, pair, serveSession }) {
  async function serveMcp(req, res) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!credentials.mcpTokenByToken(bearer)) return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    const body = JSON.parse((await readBody(req, MAX_MCP_BYTES)).toString() || 'null');
    return handleMcpRequest(req, res, body, aiById, version);
  }

  async function servePair(req, res) {
    const { status, body } = await pair(req);
    sendJson(res, status, body, CORS_HEADERS);
  }

  async function route(req, res) {
    const { pathname, searchParams } = new URL(req.url, REQUEST_URL_BASE);
    if (pathname === '/healthz') return sendText(res, 'text/plain', 'ok');
    if (pathname === BUNDLE_ROUTE && req.method === 'GET') return serveBundle(res, bundleFile);
    if (pathname === '/install.sh' && req.method === 'GET') return sendText(res, 'text/x-shellscript; charset=utf-8', installScript(baseFor(addresses, req)), { 'cache-control': 'no-cache' });
    // Discovery and pairing are called from the extension's pages, hence CORS.
    if (pathname === '/tweakline' || pathname === '/pair') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }
      if (pathname === '/tweakline' && req.method === 'GET') return sendJson(res, 200, { name: 'tweakline', version, addresses }, CORS_HEADERS);
      if (pathname === '/pair' && req.method === 'POST') return servePair(req, res);
      if (pathname === '/pair' && req.method === 'GET') return sendText(res, 'text/plain; charset=utf-8', PAIR_PAGE, CORS_HEADERS);
    }
    if (pathname === '/mcp') return serveMcp(req, res);
    const session = pathname.match(SESSION_PATH);
    if (session) return serveSession(req, res, session[1], session[2] || '', searchParams);
    return sendJson(res, 404, { error: 'not found' });
  }

  return async function handleRequest(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      sendError(req, res, error);
    }
  };
}

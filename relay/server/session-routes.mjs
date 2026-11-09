import { z } from 'zod';
import { actShape, isContentType, MAX_FILE_BYTES, nameShape, sayShape, statusShape } from '../protocol.mjs';
import { baseFor } from './network.mjs';
import { BadRequest, MAX_JSON_BYTES, parseJsonObject, parseWith, readBody, sendJson, sendText } from './http-io.mjs';

const DEFAULT_FILE_TYPE = 'application/octet-stream';
const DEFAULT_FILE_NAME = 'file';
const FILES_ROUTE_PREFIX = 'files/';
const INLINE_FILE_TYPES = /^(image|video)\//;
const BROWSER_OPS = 'This is a whole-browser session, so these also work, inside granted access: `tabs` lists tabs, `open` `{"url":"..."}` opens one, and any op takes a tab id at the top level next to `op`, not inside `args`: `{"op":"read","tab":12}`.\n';

const nameSchema = z.object(nameShape);
const saySchema = z.object(sayShape);
const statusSchema = z.object(statusShape);
const actSchema = z.object(actShape);

// The routes under a session's secret address, /s/<token>/...
export function createSessionRoutes({ store, sessions, ai, sessionFiles, instructions, addresses }) {
  function serveInstructions(req, res, session, token) {
    const isBrowser = session.kind === 'browser';
    const text = instructions.replaceAll('{{BASE}}', `${baseFor(addresses, req)}/s/${token}/`)
      .replaceAll('{{TARGET}}', isBrowser ? 'the whole browser' : 'one page')
      .replaceAll('{{BROWSER_OPS}}', isBrowser ? BROWSER_OPS : '');
    sendText(res, 'text/plain; charset=utf-8', text);
  }

  async function serveEvents(res, session, query) {
    const disconnected = new AbortController();
    res.on('close', () => disconnected.abort());
    const result = await ai.read(session, Number(query.get('after')) || 0, Number(query.get('wait')) || 0, disconnected.signal, query.get('chat'));
    if (!disconnected.signal.aborted) sendJson(res, 200, result);
  }

  function serveFile(res, session, fileId) {
    const file = store.getFile(fileId, session.id);
    if (!file) return sendJson(res, 404, { error: 'unknown file' });
    const type = isContentType(file.type) ? file.type : DEFAULT_FILE_TYPE;
    // Files come from page content and AIs: never let the browser sniff or run them on this origin.
    res.writeHead(200, {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      ...(INLINE_FILE_TYPES.test(type) ? {} : { 'content-disposition': 'attachment' }),
    });
    return res.end(file.body);
  }

  async function uploadFile(req, res, session, query) {
    const type = req.headers['content-type'] || DEFAULT_FILE_TYPE;
    if (!isContentType(type)) throw new BadRequest('content-type must be a plain type/subtype');
    const body = await readBody(req, MAX_FILE_BYTES);
    return sendJson(res, 200, sessionFiles.save(session, { name: query.get('name') || DEFAULT_FILE_NAME, type, body }));
  }

  async function serveCommand(req, res, session, route) {
    const body = parseJsonObject(await readBody(req, MAX_JSON_BYTES));
    switch (route) {
      case 'session':
        ai.name(session, parseWith(nameSchema, body));
        return sendJson(res, 200, { ok: true });
      case 'say':
        return sendJson(res, 200, { ok: true, seq: ai.say(session, parseWith(saySchema, body)).seq });
      case 'status':
        ai.status(session, parseWith(statusSchema, body));
        return sendJson(res, 200, { ok: true });
      case 'do':
        return sendJson(res, 200, await ai.act(session, parseWith(actSchema, body)));
      default:
        return sendJson(res, 404, { error: 'unknown route' });
    }
  }

  return async function serveSession(req, res, token, route, query) {
    const session = store.byToken(token);
    if (!sessions.isLive(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (req.method === 'GET') {
      if (route === '') return serveInstructions(req, res, session, token);
      if (route === 'events') return serveEvents(res, session, query);
      if (route.startsWith(FILES_ROUTE_PREFIX)) return serveFile(res, session, route.slice(FILES_ROUTE_PREFIX.length));
    }
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'unknown route' });
    if (route === 'files') return uploadFile(req, res, session, query);
    return serveCommand(req, res, session, route);
  };
}

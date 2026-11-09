import { z } from 'zod';
import { isPlainObject, TooLarge } from '../protocol.mjs';

export { TooLarge };
export const MAX_JSON_BYTES = 1024 * 1024;

export class BadRequest extends Error {}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function sendText(res, contentType, text, headers = {}) {
  res.writeHead(200, { 'content-type': contentType, ...headers });
  res.end(text);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    function onData(chunk) {
      size += chunk.length;
      if (size <= limit) { chunks.push(chunk); return; }
      // Stop reading: the 413 closes the connection, so the client cannot keep streaming into it.
      req.off('data', onData);
      req.pause();
      reject(new TooLarge('body too large'));
    }
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonObject(buffer) {
  const value = JSON.parse(buffer.toString() || '{}');
  if (!isPlainObject(value)) throw new BadRequest('body must be a JSON object');
  return value;
}

export function parseWith(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

import { isContentType, MAX_FILE_BYTES } from '../protocol.mjs';
import { check } from './checks.mjs';
import { TooLarge } from './http-io.mjs';

export function decodeBase64(base64) {
  check(typeof base64 === 'string', 'base64 must be a string');
  return Buffer.from(base64, 'base64');
}

// One path for every surface (HTTP, MCP, the browser socket), so the limits cannot drift apart.
export function createSessionFiles(store) {
  function save(session, { name, type, body }) {
    check(typeof name === 'string', 'name must be a string');
    check(isContentType(type), 'type must be a plain type/subtype');
    if (body.length > MAX_FILE_BYTES) throw new TooLarge('file too large');
    return store.putFile({ session: session.id, name, type: type.toLowerCase(), body });
  }

  function read(session, fileId) {
    const found = store.getFile(fileId, session.id);
    if (!found) throw new Error('unknown file');
    return { name: found.name, type: found.type, base64: found.body.toString('base64') };
  }

  return { save, read };
}

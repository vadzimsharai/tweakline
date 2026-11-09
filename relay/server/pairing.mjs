import { cleanLine } from './checks.mjs';
import { MAX_JSON_BYTES, parseJsonObject, readBody } from './http-io.mjs';
import { clientAddress } from './network.mjs';

const PAIR_FAILURES_PER_WINDOW = 10;
const PAIR_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_DEVICE_NAME_LENGTH = 64;
const DEFAULT_DEVICE_NAME = 'browser';
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

export const cleanDeviceName = (name) => (typeof name === 'string' ? cleanLine(name, MAX_DEVICE_NAME_LENGTH) : '');

function createFailureLimiter() {
  const failures = new Map();
  const isFresh = (entry, now) => now - entry.startedAt < PAIR_FAILURE_WINDOW_MS;

  function isBlocked(address) {
    const entry = failures.get(address);
    return Boolean(entry) && isFresh(entry, Date.now()) && entry.count >= PAIR_FAILURES_PER_WINDOW;
  }

  function record(address) {
    const now = Date.now();
    for (const [key, entry] of failures) {
      if (!isFresh(entry, now)) failures.delete(key);
    }
    const entry = failures.get(address) ?? { count: 0, startedAt: now };
    entry.count += 1;
    failures.set(address, entry);
  }

  return { isBlocked, record };
}

// A browser trades a one-time pair code for a device token; the answer is { status, body } for HTTP.
export function createPairing({ credentials, isTrustedPeer, addresses }) {
  const limiter = createFailureLimiter();

  return async function pair(req) {
    const address = clientAddress(req, isTrustedPeer);
    if (limiter.isBlocked(address)) return { status: 429, body: { error: 'too many attempts' } };
    // A web page can send a simple cross-site POST without asking; a JSON content type needs a preflight first.
    if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) return { status: 415, body: { error: 'content-type must be application/json' } };
    const request = parseJsonObject(await readBody(req, MAX_JSON_BYTES));
    if (!credentials.consumePairCode(request.code)) {
      limiter.record(address);
      return { status: 401, body: { error: 'bad code' } };
    }
    const device = credentials.createDevice(cleanDeviceName(request.name) || DEFAULT_DEVICE_NAME);
    return { status: 200, body: { deviceToken: device.token, deviceId: device.id, addresses } };
  };
}

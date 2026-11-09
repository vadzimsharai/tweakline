const DEFAULT_PORT = 8787;
const LOOPBACK_HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 1500;
const SERVER_NAME = 'tweakline';
const PAIR_LINK = /https?:\/\/\S+/;
const HOST_INPUT = /^[^\s/?#@]+$/;
const TRAILING_SLASHES = /\/+$/;

const withoutTrailingSlash = (url) => url.replace(TRAILING_SLASHES, '');
const isHttp = (protocol) => protocol === 'http:' || protocol === 'https:';

function parseUrl(text) {
  try { return new URL(text); } catch { return null; }
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export function candidates(input) {
  const text = withoutTrailingSlash(String(input ?? '').trim());
  if (!text) return [`http://${LOOPBACK_HOST}:${DEFAULT_PORT}`];
  if (text.includes('://')) {
    const full = parseUrl(text);
    return full && isHttp(full.protocol) ? [text] : [];
  }
  const parsed = HOST_INPUT.test(text) ? parseUrl(`http://${text}`) : null;
  if (!parsed) return [];
  if (isLoopbackHost(parsed.hostname)) return [`http://${parsed.hostname}:${parsed.port || DEFAULT_PORT}`];
  if (parsed.port) return [`https://${text}`, `http://${text}`];
  return [`https://${text}`, `https://${text}:${DEFAULT_PORT}`, `http://${text}`];
}

export async function probe(url) {
  try {
    const response = await fetch(`${url}/tweakline`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) return null;
    const info = await response.json();
    return info?.name === SERVER_NAME ? info : null;
  } catch {
    return null;
  }
}

export function parsePairLink(text) {
  const found = String(text ?? '').match(PAIR_LINK);
  const url = found ? parseUrl(found[0]) : null;
  if (!url || !isHttp(url.protocol) || url.username || url.password || url.search) return null;
  const code = url.hash.slice(1);
  // The server answers its socket at /ext of the origin only, so a base with a path prefix could pair but never connect.
  if (!code || url.pathname !== '/pair') return null;
  return { baseUrl: url.origin, code };
}

// A reconnect timer that waited through storage reads may wake after its server was removed or re-paired: it reopens only
// the connection it was scheduled for, to a server that still exists.
export function reconnectTarget({ connections, serverId, conn, servers }) {
  if (connections.get(serverId) !== conn) return null;
  return servers.find((server) => server.id === serverId) ?? null;
}

export function isOpenTransport(url) {
  const parsed = parseUrl(url);
  if (!parsed) return true;
  return parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname);
}

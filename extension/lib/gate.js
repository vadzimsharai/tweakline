const parseUrl = (url) => {
  try { return new URL(url); } catch { return null; }
};
const hostOf = (url) => parseUrl(url)?.hostname ?? null;
export const originOf = (url) => {
  const parsed = parseUrl(url);
  return parsed && parsed.origin !== 'null' ? parsed.origin : null;
};
const withoutHash = (url) => String(url).split('#')[0];

// A pattern must describe the whole address: `example\.com` alone must not match `https://evil.test/?example.com`.
const wholeUrl = (pattern) => new RegExp(`^(?:${pattern})$`);

export function grantCovers(grant, { tabId, url, now = Date.now() }) {
  if (grant.until !== null && grant.until !== undefined && grant.until <= now) return false;
  switch (grant.kind) {
    // A tab grant is for the site it was given on: a navigation must not carry it to another one.
    case 'tab': return grant.tabId === tabId && Boolean(grant.origin) && grant.origin === originOf(url);
    case 'page': return withoutHash(grant.url) === withoutHash(url);
    case 'site': return Boolean(grant.host) && grant.host === hostOf(url);
    case 'regexp':
      try { return wholeUrl(grant.pattern).test(url); } catch { return false; }
    default: return false;
  }
}

export const anyGrantCovers = (grants, target) => (grants || []).some((grant) => grantCovers(grant, target));

export const MAX_PATTERN_LENGTH = 500;
const QUANTIFIER_START = /[*+?{]/;

// Patterns arrive from synced servers and run in the service worker, where one catastrophic backtrack blocks everything.
// A group that holds a quantifier or an alternation and is itself repeated is where that happens, so such patterns never run.
export function isSafePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_LENGTH) return false;
  if (/\\[1-9k]/.test(pattern)) return false;
  const groups = [{ risky: false }];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') { i += 1; continue; }
    if (inClass) { if (char === ']') inClass = false; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === '(') { groups.push({ risky: false }); continue; }
    if (char === '|') { groups[groups.length - 1].risky = true; continue; }
    if (QUANTIFIER_START.test(char) && !(char === '?' && pattern[i - 1] === '(')) { groups[groups.length - 1].risky = true; continue; }
    if (char === ')') {
      if (groups.length === 1) return false;
      const closed = groups.pop();
      if (closed.risky && QUANTIFIER_START.test(pattern[i + 1] ?? '')) return false;
      if (closed.risky) groups[groups.length - 1].risky = true;
    }
  }
  return true;
}

// Why a pattern typed for a patch cannot be saved, or null when it can.
export function patternProblem(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return 'Enter a pattern';
  if (pattern.length > MAX_PATTERN_LENGTH) return `A pattern can be at most ${MAX_PATTERN_LENGTH} characters`;
  try { wholeUrl(pattern); } catch { return 'This is not a valid pattern'; }
  if (!isSafePattern(pattern)) return 'This pattern repeats a group that has its own repeat or choice, which can freeze the browser. Simplify it';
  return null;
}

const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function hostMatches(maskHost, host) {
  if (maskHost.startsWith('*.')) {
    const parent = maskHost.slice(2);
    return !parent.includes('*') && host.endsWith(`.${parent}`);
  }
  return !maskHost.includes('*') && maskHost === host;
}

// A mask is host + path: the host matches exactly (or `*.` for its subdomains), `*` works inside the path only,
// and the query counts only when the mask has one.
function maskMatches(mask, parsed) {
  const slash = mask.search(/[/?]/);
  const maskHost = (slash < 0 ? mask : mask.slice(0, slash)).toLowerCase();
  const rest = slash < 0 ? '/' : mask.slice(slash);
  if (!hostMatches(maskHost, parsed.host)) return false;
  const queryAt = rest.indexOf('?');
  const maskPath = queryAt < 0 ? rest : rest.slice(0, queryAt);
  const path = `${maskPath.startsWith('/') ? '' : '/'}${escapeRegExp(maskPath).replaceAll('*', '[^?#]*')}`;
  if (queryAt < 0) return new RegExp(`^${path}$`).test(parsed.pathname);
  const query = escapeRegExp(rest.slice(queryAt)).replaceAll('*', '[^#]*');
  return new RegExp(`^${path}${query}$`).test(`${parsed.pathname}${parsed.search}`);
}

export function patchMatches(patch, url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (patch.pattern) {
    if (!isSafePattern(patch.pattern)) return false;
    try { return wholeUrl(patch.pattern).test(url); } catch { return false; }
  }
  if (!patch.mask || typeof patch.mask !== 'string') return false;
  return maskMatches(patch.mask, parsed);
}

// A scope the AI suggests is offered only when it covers this page and stays on this host.
export function maskFitsPage(mask, url) {
  const parsed = parseUrl(url);
  if (!parsed || typeof mask !== 'string' || !mask) return false;
  const maskHost = mask.split(/[/?]/)[0].toLowerCase();
  return maskHost === parsed.host && maskMatches(mask, parsed);
}

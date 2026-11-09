import { originOf } from './gate.js';

// Bindings left from before a browser restart keep their page but lose their tab id, which the browser hands out again.
export const isTabKey = (key) => /^\d+$/.test(key);
export const RESTART_KEY_PREFIX = 'restart:';

export const pageOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
};

export const tabsBoundTo = (map, serverId, sessionId) => Object.entries(map)
  .filter(([tabId, bound]) => isTabKey(tabId) && bound?.serverId === serverId && bound.sessionId === sessionId)
  .map(([tabId]) => Number(tabId));

// The tab the person joined last, not the one with the highest id.
export function latestBoundTab(map, serverId, sessionId) {
  const boundAt = (tabId) => map[tabId].boundAt ?? 0;
  const tabs = tabsBoundTo(map, serverId, sessionId).sort((a, b) => boundAt(a) - boundAt(b) || a - b);
  return tabs.length ? tabs[tabs.length - 1] : null;
}

const withoutHash = (url) => String(url).split('#')[0];
export const sameAddress = (a, b) => Boolean(a) && Boolean(b) && withoutHash(a) === withoutHash(b);

// A tab keeps its own binding only while it stays on the site the binding was made on.
export const ownBindingFor = (own, url) => (own.url && originOf(own.url) !== originOf(url) ? null : own);

// A binding left by a tab that is gone goes to a tab on the same address, else on the same page, else on the same site.
// The first kind of match that has any candidates decides: with more than one the binding stays orphaned, since
// taking either could hand one tab's session to another.
export function findOrphanBinding(map, openTabIds, url) {
  const orphans = Object.entries(map).filter(([tabId, bound]) => bound?.url && !openTabIds.has(tabId));
  const matches = [
    ([, bound]) => sameAddress(bound.url, url),
    ([, bound]) => pageOf(bound.url) === pageOf(url),
    ([, bound]) => originOf(bound.url) === originOf(url),
  ];
  for (const match of matches) {
    const found = orphans.filter(match);
    if (found.length) return found.length === 1 ? found[0] : null;
  }
  return null;
}

// `keep` tells which tab ids still mean the same tab, as after an extension update, when the browser keeps its ids.
export function withRestartKeys(map, now, keep = () => false) {
  const moved = {};
  let index = 0;
  for (const [key, bound] of Object.entries(map)) {
    if (!bound) continue;
    moved[isTabKey(key) && !keep(key, bound) ? `${RESTART_KEY_PREFIX}${now}-${index++}` : key] = bound;
  }
  return moved;
}

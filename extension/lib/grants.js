import { anyGrantCovers, grantCovers, originOf } from './gate.js';

export const isTabGrant = (grant) => grant?.kind === 'tab';

// Storage hands objects back with their keys sorted, so equality must not depend on key order.
export const grantKey = (grant) => JSON.stringify(Object.keys(grant).sort().map((field) => [field, grant[field]]));

// A tab grant is for the tab that asked and the site it shows now.
export function grantForTab(asked, tab) {
  const grant = asked.kind === 'tab' ? { ...asked, tabId: tab.id, origin: originOf(tab.url) } : asked;
  if (grant.kind === 'tab' && !grant.origin) throw new Error('This page cannot be granted by tab');
  return grant;
}

// A grant that would cover the target if it had not run out, and whose end the chat has not been told about yet.
export const findEndedGrant = (grants, target, now) => grants.find((grant) => grant.until && grant.until <= now && !grant.endNoticed && grantCovers({ ...grant, until: null }, target));

// Revoking goes by what the grant is, not by its place in a list another tab may have changed meanwhile.
export const withoutGrant = (list, grant) => list.filter((g) => grantKey(g) !== grantKey(grant));

export function removeLastMatching(list, matches) {
  const at = (list || []).findLastIndex(matches);
  if (at >= 0) list.splice(at, 1);
}

export const tabsCoveredBy = (tabs, grants) => tabs
  .filter((tab) => anyGrantCovers(grants, { tabId: tab.id, url: tab.url || '' }))
  .map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active }));

// The top frame and the tab must both be covered, and a tab already loading another site is not acted on.
export function checkTabOp({ grants, tabId, url, tab, op, args }) {
  const place = (where) => ({ tabId, url: where });
  const covers = (where) => anyGrantCovers(grants, place(where));
  if (!covers(url) || (tab.url && !covers(tab.url))) return { refused: place(url) };
  if (tab.pendingUrl && originOf(tab.pendingUrl) !== originOf(url)) return { error: 'the tab is opening another site, try again when it has loaded' };
  if (op === 'navigate' && !covers(args.url)) return { refused: place(args.url) };
  return { allowed: true };
}

export const grantsCovering = (grants, target) => grants.filter((grant) => grantCovers(grant, target));

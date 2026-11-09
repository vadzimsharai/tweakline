import { findEndedGrant, grantKey, isTabGrant, removeLastMatching, withoutGrant } from '../lib/grants.js';
import { store, update } from './storage.js';
import { deliverToTabs } from './tabs.js';

export const sessionGrants = async (sessionId) => (await store.get('grants', {}))[sessionId] || [];

// "Every session" grants are the owner's explicit choice to let any session act on that page or site.
export const grantsOf = async (sessionId) => [...await sessionGrants(sessionId), ...await store.get('alwaysGrants', [])];

export async function dropTabGrants(matches) {
  await update('grants', {}, (all) => { for (const id of Object.keys(all)) all[id] = (all[id] || []).filter((g) => !(isTabGrant(g) && matches(g))); });
  await update('alwaysGrants', [], (all) => all.filter((g) => !(isTabGrant(g) && matches(g))));
}

export const dropSessionGrants = (ids) => update('grants', {}, (all) => { for (const id of ids) delete all[id]; });

// An op refused only because a grant ran out tells the chat once, so the person can grant again.
export async function refuseAccess(serverId, sessionId, grants, target) {
  const ended = findEndedGrant(grants, target, Date.now());
  if (ended) {
    const key = JSON.stringify(ended);
    await update('grants', {}, (all) => { for (const g of all[sessionId] || []) if (JSON.stringify(g) === key) g.endNoticed = true; });
    deliverToTabs(serverId, sessionId, { type: 'accessEnded', session: sessionId });
  }
  return new Error('not granted');
}

// Resolves to whether the grant was stored: an "every session" grant that is already there is not added twice.
export async function addGrant(sessionId, grant) {
  const key = grantKey(grant);
  let added = false;
  if (grant.always) await update('alwaysGrants', [], (all) => { if (!all.some((g) => grantKey(g) === key)) { all.push(grant); added = true; } });
  else await update('grants', {}, (all) => { all[sessionId] = [...(all[sessionId] || []), grant]; added = true; });
  return added;
}

export async function removeAddedGrant(sessionId, grant) {
  const key = grantKey(grant);
  const same = (g) => grantKey(g) === key;
  if (grant.always) await update('alwaysGrants', [], (all) => removeLastMatching(all, same));
  else await update('grants', {}, (all) => { removeLastMatching(all[sessionId], same); if (!all[sessionId]?.length) delete all[sessionId]; });
}

export const alwaysGrants = () => store.get('alwaysGrants', []);
export const revokeAlwaysGrant = (grant) => update('alwaysGrants', [], (all) => withoutGrant(all, grant));
export const clearSessionGrants = (sessionId) => update('grants', {}, (all) => { delete all[sessionId]; });

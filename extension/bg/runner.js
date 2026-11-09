import { checkTabOp, grantsCovering, tabsCoveredBy } from '../lib/grants.js';
import { anyGrantCovers } from '../lib/gate.js';
import { createKeyedQueue } from '../lib/queue.js';
import { grantsOf, refuseAccess } from './grants.js';
import { getSessions } from './storage.js';
import { topFrame } from './tabs.js';

const BROWSER_ONLY_OPS = new Set(['open', 'tabs']);

export function createOpRunner({ ops, resolveTab }) {
  // One op at a time per tab: an op that starts a navigation must finish before the next one is checked.
  const tabQueue = createKeyedQueue();

  async function runBrowserOp(serverId, session, op, args) {
    const grants = await grantsOf(session.id);
    if (session.kind !== 'browser') throw new Error('this op needs a whole-browser session');
    if (op === 'tabs') return tabsCoveredBy(await chrome.tabs.query({}), grants);
    const opening = { tabId: -1, url: args.url };
    if (!anyGrantCovers(grants, opening)) throw await refuseAccess(serverId, session.id, grants, opening);
    const opened = await chrome.tabs.create({ url: args.url, active: true });
    return { tab: opened.id };
  }

  // The check and the act share one document: ops get its id, so a page that changed after the check refuses them.
  async function runOnTab(serverId, sessionId, op, args, tabId) {
    const grants = await grantsOf(sessionId);
    const [tab, frame] = await Promise.all([chrome.tabs.get(tabId), topFrame(tabId)]);
    const url = frame?.url || tab.url || '';
    const check = checkTabOp({ grants, tabId, url, tab, op, args });
    if (check.refused) throw await refuseAccess(serverId, sessionId, grants, check.refused);
    if (check.error) throw new Error(check.error);
    const handler = ops[op];
    if (!handler) throw new Error(`unknown op ${op}`);
    if (!frame?.documentId) throw new Error('the page is not ready, try again');
    const guard = grantsCovering(grants, { tabId, url, now: Date.now() });
    return handler({ tabId, documentId: frame.documentId, guard, args, session: sessionId });
  }

  // Grants are keyed by session id, so a session only counts on the server that created it: otherwise any paired server could borrow another's grants.
  async function runOp(serverId, { session: sessionId, op, args, tab }) {
    const local = (await getSessions())[sessionId];
    if (!local || local.serverId !== serverId) throw new Error('unknown session');
    const session = { ...local, id: sessionId };
    if (BROWSER_ONLY_OPS.has(op)) return runBrowserOp(serverId, session, op, args);
    const target = await resolveTab(session, tab);
    return tabQueue.run(target.id, () => runOnTab(serverId, sessionId, op, args || {}, target.id));
  }

  return { runOp, forgetTab: tabQueue.forget };
}

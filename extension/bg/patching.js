import { patchMatches } from '../lib/gate.js';
import { pageTarget, runPageJs } from '../lib/ops.js';
import { createPatches } from '../lib/patches.js';
import { getServers, getTabSessions, store } from './storage.js';
import { sendToTab, topFrame } from './tabs.js';

const PATCH_PULL_WAIT_MS = 1500;
const DONE = Object.freeze({ ok: true });
const PAGE_CHANGED = 'the page changed, open the patches again';

const failed = (error) => ({ ok: false, reason: error.message });

// The scope is checked on the document the code then runs in: a tab that moved on meanwhile refuses it.
async function runPatchJs(tabId, patch, code, page) {
  const frame = page ?? await topFrame(tabId);
  if (!frame?.documentId || !patchMatches(patch, frame.url || '')) throw new Error(PAGE_CHANGED);
  await runPageJs(tabId, code, { documentId: frame.documentId, onlyAt: frame.url });
}

async function applyPatch(tabId, patch, page = null) {
  if (patch.css) {
    try {
      await chrome.scripting.insertCSS({ target: pageTarget(tabId, page?.documentId), css: patch.css, origin: 'USER' });
    } catch (error) {
      return failed(error);
    }
  }
  if (!patch.js) return DONE;
  if (!patch.jsApproved) return { ok: false, reason: 'not-approved' };
  try {
    await runPatchJs(tabId, patch, patch.js, page);
    return DONE;
  } catch (error) {
    return failed(error);
  }
}

// JS changes stay on the page until its undo runs; without one only a reload takes them away.
async function removePatch(tabId, patch) {
  if (patch.css) {
    try {
      await chrome.scripting.removeCSS({ target: { tabId }, css: patch.css, origin: 'USER' });
    } catch (error) {
      return failed(error);
    }
  }
  if (!patch.js || !patch.jsApproved) return DONE;
  if (!patch.undo) return { ok: true, reload: true };
  try {
    await runPatchJs(tabId, patch, patch.undo);
    return DONE;
  } catch {
    return { ok: true, reload: true };
  }
}

async function currentServerFor(tab) {
  const bound = (await getTabSessions())[tab.id];
  if (bound?.serverId) return bound.serverId;
  const servers = await getServers();
  if (servers.length === 1) return servers[0].id;
  throw new Error(servers.length ? 'Open a session on the right server' : 'Connect a server first');
}

export function proposePatch(tabId, session, proposal) {
  sendToTab(tabId, { type: 'proposePatch', session, proposal });
  return { asked: true };
}

export function createPatching({ call, readyServerIds }) {
  const patches = createPatches({ store, call });
  const find = async (id) => (await patches.list()).find((p) => p.id === id);

  async function pullFromConnected() {
    const pulls = readyServerIds().map((serverId) => patches.pull(serverId));
    await Promise.race([Promise.allSettled(pulls), new Promise((resolve) => setTimeout(resolve, PATCH_PULL_WAIT_MS))]);
  }

  // Called on commit, with the new document: its id pins every injection to it.
  async function applyAutoPatches(tabId, page) {
    if (!/^https?:/.test(page.url)) return;
    for (const patch of await patches.list()) {
      if (patch.on && patch.auto && patchMatches(patch, page.url)) await applyPatch(tabId, patch, page);
    }
  }

  // Only a patch the person switched on and allowed gets its scope tested: a synced one stays untouched until then.
  async function listForTab(tab) {
    await pullFromConnected();
    return (await patches.list()).map((patch) => ({ ...patch, here: patch.on && (!patch.js || patch.jsApproved) && patchMatches(patch, tab.url) }));
  }

  async function save({ patch, prefs, replaces }, tab) {
    if (!replaces) return patches.save(patch, prefs);
    const url = tab.url || '';
    const before = await find(replaces);
    await patches.replace(replaces, patch, prefs);
    const removed = before && before.on && patchMatches(before, url) ? await removePatch(tab.id, before) : DONE;
    if (removed.reload) return { reload: true };
    const now = await find(replaces);
    const applied = now && patchMatches(now, url) ? await applyPatch(tab.id, now) : DONE;
    return applied.ok === false && applied.reason !== 'not-approved' ? { replaced: true, failed: applied.reason } : { replaced: true };
  }

  async function setPrefs({ id, on, auto, approve }, tab) {
    await patches.setPrefs({ id, on, auto, approve: approve && typeof approve === 'object' ? approve : undefined });
    const patch = await find(id);
    if (!patch || !patchMatches(patch, tab.url || '')) return DONE;
    if (on === true) return applyPatch(tab.id, patch);
    if (on === false) return removePatch(tab.id, patch);
    return DONE;
  }

  const setSync = async ({ id, sync }, tab) => patches.setSync(id, sync, sync ? await currentServerFor(tab) : null);

  return { pull: patches.pull, remove: patches.remove, forgetServer: patches.forgetServer, applyAutoPatches, listForTab, save, setPrefs, setSync };
}

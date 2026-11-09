import { isSafePattern, patternProblem } from './gate.js';

const CONTENT_FIELDS = ['site', 'title', 'desc', 'mask', 'pattern', 'css', 'js', 'undo', 'request', 'before', 'after', 'createdAt'];
const SCOPE_FIELDS = ['mask', 'pattern'];
const APPLIED_FIELDS = [...SCOPE_FIELDS, 'css', 'js', 'undo'];

// Approval on a device covers every piece of code that may run on the page, the undo included.
export const patchCode = (patch) => (patch.undo ? `${patch.js}\n/* undo */\n${patch.undo}` : patch.js);
// Approval is for this code on this scope: the same code moved to a wider scope must be shown again.
export const patchApproval = (patch) => JSON.stringify([patchCode(patch) ?? '', patch.mask ?? '', patch.pattern ?? '']);

const differs = (a, b, fields) => fields.some((field) => (a[field] ?? '') !== (b[field] ?? ''));
const isUsable = (patch) => Boolean(patch) && typeof patch.id === 'string' && patch.id !== '' && typeof patch.site === 'string'
  && APPLIED_FIELDS.every((field) => patch[field] === undefined || patch[field] === null || typeof patch[field] === 'string')
  && (!patch.pattern || isSafePattern(patch.pattern));

// A patch scoped by pattern is never stored with one that could not run safely, or with none at all.
function checkScope(patch) {
  if (patch.mask || !('pattern' in patch)) return;
  const problem = patternProblem(patch.pattern);
  if (problem) throw new Error(problem);
}

function pickContent(patch) {
  const picked = { id: patch.id };
  for (const field of CONTENT_FIELDS) if (patch[field] !== undefined) picked[field] = patch[field];
  return picked;
}

export function createPatches({ store, call, newId = () => crypto.randomUUID(), now = Date.now }) {
  const readPatches = () => store.get('patches', []);
  const readPrefs = () => store.get('patchPrefs', {});
  const readDeleted = () => store.get('patchDeletes', []);

  // Storage has no transactions, and a pull can land in the middle of a save.
  let queue = Promise.resolve();
  const locked = (run) => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };

  async function list() {
    const [patches, prefs] = await Promise.all([readPatches(), readPrefs()]);
    return patches.map((patch) => ({
      ...patch,
      sync: Boolean(patch.sync),
      on: prefs[patch.id]?.on ?? false,
      auto: prefs[patch.id]?.auto ?? false,
      jsApproved: Boolean(patch.js) && prefs[patch.id]?.jsApproval === patchApproval(patch),
    }));
  }

  const save = (patch, options = {}) => locked(async () => {
    checkScope(patch);
    const at = now();
    const saved = { ...patch, id: newId(), createdAt: at, updatedAt: at, sync: false };
    await store.set('patches', [...await readPatches(), saved]);
    const prefs = await readPrefs();
    prefs[saved.id] = { on: true, auto: Boolean(options.auto), jsApproval: options.approveJs ? patchApproval(saved) : undefined };
    await store.set('patchPrefs', prefs);
    return saved;
  });

  // Changing a saved patch keeps its id, sync and place in the list; its code needs approval again.
  const update = (id, patch, options = {}) => locked(async () => {
    const patches = await readPatches();
    const old = patches.find((p) => p.id === id);
    if (!old) throw new Error('Patch not found');
    checkScope(patch);
    const saved = { ...old, ...patch, id, createdAt: old.createdAt, updatedAt: now() };
    // A new scope replaces the old one whole: a mask must not leave the old pattern behind, or the reverse.
    if (SCOPE_FIELDS.some((field) => field in patch)) for (const field of SCOPE_FIELDS) if (!(field in patch)) delete saved[field];
    const prefs = await readPrefs();
    prefs[id] = { ...prefs[id], on: true, auto: Boolean(options.auto), jsApproval: options.approveJs ? patchApproval(saved) : undefined };
    await store.set('patchPrefs', prefs);
    await store.set('patches', patches.map((p) => (p.id === id ? saved : p)));
    return { old, saved };
  });

  // `approve` is what the person was shown: its code and scope must still be what is stored, or nothing is approved.
  const setPrefs = ({ id, on, auto, approve }) => locked(async () => {
    const prefs = await readPrefs();
    const next = { ...prefs[id] };
    if (on !== undefined) next.on = on;
    if (auto !== undefined) next.auto = auto;
    const stored = approve ? (await readPatches()).find((p) => p.id === id) : null;
    if (stored?.js && patchApproval(stored) === patchApproval(approve)) next.jsApproval = patchApproval(stored);
    prefs[id] = next;
    await store.set('patchPrefs', prefs);
  });

  const changeOne = (id, change) => locked(async () => {
    const patches = await readPatches();
    await store.set('patches', patches.map((patch) => (patch.id === id ? { ...patch, ...change } : patch)));
  });
  const changeIf = (id, still, change) => locked(async () => {
    const patches = await readPatches();
    await store.set('patches', patches.map((patch) => (patch.id === id && still(patch) ? { ...patch, ...change } : patch)));
  });
  // The server stamps its own time; keeping it means the next pull sees the copies as equal.
  const syncedAt = (answer, patch) => (typeof answer?.updatedAt === 'number' ? answer.updatedAt : patch.updatedAt);

  async function setSync(id, sync, serverId) {
    const patch = (await readPatches()).find((p) => p.id === id);
    if (!patch) throw new Error('Patch not found');
    if (sync) {
      await call(serverId, 'patch.put', { patch: { ...pickContent(patch), updatedAt: patch.updatedAt } });
      await changeOne(id, { sync: true, syncServer: serverId, fromSync: false });
    } else {
      if (patch.sync) await call(patch.syncServer, 'patch.delete', { id });
      await changeOne(id, { sync: false, syncServer: null, fromSync: false });
    }
  }

  async function remove(id) {
    const patch = (await readPatches()).find((p) => p.id === id);
    await locked(async () => {
      await store.set('patches', (await readPatches()).filter((p) => p.id !== id));
      const prefs = await readPrefs();
      delete prefs[id];
      await store.set('patchPrefs', prefs);
    });
    if (!patch?.sync) return;
    try {
      await call(patch.syncServer, 'patch.delete', { id });
    } catch {
      await locked(async () => store.set('patchDeletes', [...await readDeleted(), { id, serverId: patch.syncServer }]));
    }
  }

  async function flushDeletes(serverId) {
    const waiting = (await readDeleted()).filter((item) => item.serverId === serverId);
    for (const { id } of waiting) {
      await call(serverId, 'patch.delete', { id });
      await locked(async () => store.set('patchDeletes', (await readDeleted()).filter((item) => !(item.id === id && item.serverId === serverId))));
    }
  }

  // Pushed before every merge, so an edit made offline is not overwritten by the older server copy.
  async function pushDirty(serverId) {
    const dirty = (await readPatches()).filter((p) => p.dirty && p.sync && p.syncServer === serverId);
    for (const patch of dirty) {
      const answer = await call(serverId, 'patch.put', { patch: { ...pickContent(patch), updatedAt: patch.updatedAt } });
      await changeIf(patch.id, (p) => p.updatedAt === patch.updatedAt, { dirty: false, updatedAt: syncedAt(answer, patch) });
    }
  }

  function mergeOne(local, remote, prefs) {
    if (local.dirty || (local.updatedAt ?? 0) > (remote.updatedAt ?? 0)) return local;
    const updated = { ...local, ...pickContent(remote), updatedAt: remote.updatedAt ?? local.updatedAt };
    // A scope changed elsewhere replaces the old one whole: a pattern left beside a new mask would still decide where the code runs.
    if (differs(local, remote, SCOPE_FIELDS)) for (const field of SCOPE_FIELDS) if (!remote[field]) delete updated[field];
    if (!differs(local, remote, APPLIED_FIELDS)) return updated;
    // What the server sends must never reach a page by itself: a changed patch waits for the person.
    const next = { ...prefs[local.id], on: false };
    if (differs(local, remote, SCOPE_FIELDS)) next.jsApproval = undefined;
    prefs[local.id] = next;
    return updated;
  }

  const pull = async (serverId) => {
    await flushDeletes(serverId);
    await pushDirty(serverId);
    const answer = await call(serverId, 'patch.list', {});
    if (!Array.isArray(answer)) return;
    const remote = new Map(answer.filter(isUsable).map((patch) => [patch.id, patch]));
    await locked(async () => {
      const prefs = await readPrefs();
      const kept = [];
      const locals = await readPatches();
      for (const local of locals) {
        const mine = local.sync && local.syncServer === serverId;
        const copy = remote.get(local.id);
        remote.delete(local.id);
        if (!mine) kept.push(local);
        else if (copy) kept.push(mergeOne(local, copy, prefs));
        else if (!local.fromSync || prefs[local.id]) kept.push({ ...local, sync: false, syncServer: null, fromSync: false });
      }
      for (const patch of remote.values()) kept.push({ ...pickContent(patch), updatedAt: patch.updatedAt, sync: true, syncServer: serverId, fromSync: true });
      // Prefs first: if the second write fails, a changed patch is already switched off.
      await store.set('patchPrefs', prefs);
      await store.set('patches', kept);
    });
  };

  const forgetServer = (serverId) => locked(async () => {
    const patches = await readPatches();
    await store.set('patches', patches.map((patch) => (patch.syncServer === serverId ? { ...patch, sync: false, syncServer: null, fromSync: false } : patch)));
    await store.set('patchDeletes', (await readDeleted()).filter((item) => item.serverId !== serverId));
  });

  async function replace(id, patch, options) {
    const { old, saved } = await update(id, patch, options);
    if (!saved.sync) return { old, saved };
    const unchanged = (p) => p.updatedAt === saved.updatedAt;
    try {
      const answer = await call(saved.syncServer, 'patch.put', { patch: { ...pickContent(saved), updatedAt: saved.updatedAt } });
      await changeIf(id, unchanged, { dirty: false, updatedAt: syncedAt(answer, saved) });
    } catch {
      await changeIf(id, unchanged, { dirty: true });
    }
    return { old, saved };
  }

  return { list, save, replace, setPrefs, setSync, remove, pull, forgetServer };
}

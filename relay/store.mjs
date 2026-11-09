import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject, MAX_EVENT_BYTES, MAX_SESSION_EVENT_BYTES, MAX_SESSION_FILE_BYTES, MAX_SESSION_FILES, TooLarge } from './protocol.mjs';

const MAX_EVENTS_PER_SESSION = 2000;
const FILE_RETENTION_MS = 7 * 24 * 3600 * 1000;
const ID_BYTES = 12;
const TOKEN_BYTES = 32;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const ID_PATTERN = /^[\w-]+$/;
const SERVER_INFO_FILE = 'server.json';
const CHAT_PREFIX = 'c';
const FIRST_CHAT = `${CHAT_PREFIX}1`;
const CHAT_PATTERN = /^c([1-9]\d*)$/;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newId = () => crypto.randomBytes(ID_BYTES).toString('base64url');
const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');
const makePrivateDir = (dir) => fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });

function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: PRIVATE_FILE_MODE });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// A truncated file from a crash or a full disk, or a folder or an unreadable file under a record's name,
// must cost only that record, not the whole server.
function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.error(`tweakline: skipping unreadable ${file}: ${error.message}`);
    return null;
  }
}

// The next save would overwrite the only copy, so a broken file is moved aside for a person to recover.
function keepAside(file) {
  const kept = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, kept);
    console.error(`tweakline: kept the unreadable ${file} as ${kept}`);
  } catch (error) {
    console.error(`tweakline: could not move the unreadable ${file} aside: ${error.message}`);
  }
}

const isEvent = (event) => isPlainObject(event) && Number.isInteger(event.seq) && typeof event.type === 'string';

function isSessionShape(session, name) {
  return isPlainObject(session)
    && typeof session.id === 'string' && ID_PATTERN.test(session.id) && name === `${session.id}.json`
    && Array.isArray(session.tokenHashes) && session.tokenHashes.every((hash) => typeof hash === 'string')
    && Array.isArray(session.events) && session.events.every(isEvent)
    && typeof session.owner === 'string' && Number.isInteger(session.seq);
}

const isPatchShape = (patch) => isPlainObject(patch) && typeof patch.id === 'string';
const byteSize = (value) => Buffer.byteLength(JSON.stringify(value));

export const preferredAddress = (addresses) => addresses.find((a) => a.kind === 'public') ?? addresses[0];

export function writeServerInfo(dataDir, info) {
  makePrivateDir(dataDir);
  writeAtomic(path.join(dataDir, SERVER_INFO_FILE), JSON.stringify(info));
}

export const readServerInfo = (dataDir) => readJsonIfPresent(path.join(dataDir, SERVER_INFO_FILE));

// One file per secret, reread on every use: `tweakline pair` and `tweakline token` change these from
// another process while the server runs, and a shared file would lose concurrent updates.
export function openCredentials(dataDir) {
  const pairDir = path.join(dataDir, 'pair-codes');
  const devicesDir = path.join(dataDir, 'devices');
  const tokensDir = path.join(dataDir, 'mcp-tokens');
  for (const dir of [pairDir, devicesDir, tokensDir]) makePrivateDir(dir);

  const recordFile = (dir, id) => path.join(dir, `${id}.json`);
  const records = (dir) => fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonIfPresent(path.join(dir, name)))
    .filter(Boolean);
  const byToken = (dir, token) => {
    if (typeof token !== 'string' || !token) return null;
    const tokenHash = hashToken(token);
    return records(dir).find((record) => record.tokenHash === tokenHash) ?? null;
  };
  const addRecord = (dir, name) => {
    const token = newToken();
    const record = { id: newId(), name, tokenHash: hashToken(token), createdAt: Date.now() };
    writeAtomic(recordFile(dir, record.id), JSON.stringify(record));
    return { id: record.id, name, token };
  };
  const describe = (dir, kind) => records(dir).map(({ id, name, createdAt }) => ({ id, kind, name, createdAt }));

  return {
    createPairCode(ttlMs = PAIR_CODE_TTL_MS) {
      const code = newToken();
      writeAtomic(recordFile(pairDir, hashToken(code)), JSON.stringify({ expiresAt: Date.now() + ttlMs }));
      return code;
    },
    consumePairCode(code) {
      if (typeof code !== 'string' || !code) return false;
      const file = recordFile(pairDir, hashToken(code));
      const record = readJsonIfPresent(file);
      if (!record) return false;
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      return record.expiresAt > Date.now();
    },
    sweepPairCodes(now = Date.now()) {
      for (const name of fs.readdirSync(pairDir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(pairDir, name);
        const record = readJsonIfPresent(file);
        if (record && record.expiresAt <= now) fs.rmSync(file, { force: true });
      }
    },
    createDevice: (name) => addRecord(devicesDir, name),
    deviceByToken: (token) => byToken(devicesDir, token),
    deviceExists: (id) => fs.existsSync(recordFile(devicesDir, id)),
    renameDevice(id, name) {
      const record = readJsonIfPresent(recordFile(devicesDir, id));
      if (record) writeAtomic(recordFile(devicesDir, id), JSON.stringify({ ...record, name }));
    },
    createMcpToken: (name) => addRecord(tokensDir, name),
    mcpTokenByToken: (token) => byToken(tokensDir, token),
    list: () => [...describe(tokensDir, 'mcp'), ...describe(devicesDir, 'device')],
    revoke(id) {
      if (!ID_PATTERN.test(id)) return null;
      for (const [dir, kind] of [[tokensDir, 'mcp'], [devicesDir, 'device']]) {
        if (!fs.existsSync(recordFile(dir, id))) continue;
        fs.rmSync(recordFile(dir, id), { force: true });
        return kind;
      }
      return null;
    },
  };
}

function loadSession(file, name) {
  const session = readJsonIfPresent(file);
  if (!isSessionShape(session, name)) {
    console.error(`tweakline: skipping ${file}: not a session record`);
    keepAside(file);
    return null;
  }
  // Sessions saved before chats existed hold one conversation, so all of it becomes the first chat.
  session.chat ??= FIRST_CHAT;
  session.chatCount ??= 1;
  for (const event of session.events) event.chat ??= FIRST_CHAT;
  return session;
}

function loadPatches(file) {
  const saved = readJsonIfPresent(file);
  if (!Array.isArray(saved)) {
    if (fs.existsSync(file)) keepAside(file);
    return [];
  }
  const patches = saved.filter(isPatchShape);
  if (patches.length !== saved.length) console.error(`tweakline: skipped ${saved.length - patches.length} malformed patches in ${file}`);
  return patches;
}

export function openStore(dataDir, {
  maxSessionEventBytes = MAX_SESSION_EVENT_BYTES, maxSessionFiles = MAX_SESSION_FILES, maxSessionFileBytes = MAX_SESSION_FILE_BYTES,
} = {}) {
  const sessionsDir = path.join(dataDir, 'sessions');
  const filesDir = path.join(dataDir, 'files');
  const patchesFile = path.join(dataDir, 'patches.json');
  makePrivateDir(sessionsDir);
  makePrivateDir(filesDir);

  const sessions = new Map();
  for (const name of fs.readdirSync(sessionsDir)) {
    if (!name.endsWith('.json')) continue;
    const session = loadSession(path.join(sessionsDir, name), name);
    if (session) sessions.set(session.id, session);
  }
  const byHash = new Map([...sessions.values()].flatMap((s) => s.tokenHashes.map((hash) => [hash, s])));
  let patches = loadPatches(patchesFile);

  const sessionFile = (id) => path.join(sessionsDir, `${id}.json`);
  // Memory changes only after the file is written: a state that cannot be saved never becomes the session.
  function commit(session, fields) {
    writeAtomic(sessionFile(session.id), JSON.stringify({ ...session, ...fields }));
    Object.assign(session, fields);
  }
  const savePatches = (next) => {
    writeAtomic(patchesFile, JSON.stringify(next));
    patches = next;
  };
  const fileMeta = (id) => path.join(filesDir, `${id}.json`);
  const fileBody = (id) => path.join(filesDir, `${id}.bin`);

  const eventSizes = new WeakMap();
  function sizesOf(session) {
    if (!eventSizes.has(session)) {
      const sizes = session.events.map(byteSize);
      eventSizes.set(session, { sizes, total: sizes.reduce((sum, size) => sum + size, 0) });
    }
    return eventSizes.get(session);
  }

  // Per session, the files it holds in the order they came, with their sizes.
  const filesBySession = new Map();
  const filesOf = (sessionId) => filesBySession.get(sessionId) ?? new Map();
  function indexFile(sessionId, id, size) {
    filesBySession.set(sessionId, filesOf(sessionId).set(id, size));
  }
  function removeFile(sessionId, id) {
    fs.rmSync(fileMeta(id), { force: true });
    fs.rmSync(fileBody(id), { force: true });
    const files = filesOf(sessionId);
    files.delete(id);
    if (!files.size) filesBySession.delete(sessionId);
  }
  function fileRecords() {
    return fs.readdirSync(filesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ id: name.slice(0, -'.json'.length), meta: readJsonIfPresent(path.join(filesDir, name)) }))
      .filter(({ id, meta }) => ID_PATTERN.test(id) && isPlainObject(meta) && typeof meta.session === 'string');
  }
  function bodySize(id) {
    try {
      return fs.statSync(fileBody(id)).size;
    } catch {
      return 0;
    }
  }
  const known = fileRecords().sort((a, b) => (a.meta.at ?? 0) - (b.meta.at ?? 0));
  for (const { id, meta } of known) indexFile(meta.session, id, Number.isInteger(meta.size) ? meta.size : bodySize(id));
  // Distinct times keep the oldest-first order of files across restarts.
  let lastFileAt = Number(known.at(-1)?.meta.at) || 0;

  return {
    createSession({ kind, tab, owner, device }) {
      const token = newToken();
      const session = {
        id: newId(), tokenHashes: [hashToken(token)], kind, tab: tab ?? null, owner, device,
        title: '', ai: '', createdAt: Date.now(), lastAt: Date.now(), seq: 0, events: [], chat: FIRST_CHAT, chatCount: 1,
      };
      writeAtomic(sessionFile(session.id), JSON.stringify(session));
      sessions.set(session.id, session);
      byHash.set(session.tokenHashes[0], session);
      return { session, token };
    },
    addToken(session) {
      const token = newToken();
      const tokenHash = hashToken(token);
      commit(session, { tokenHashes: [...session.tokenHashes, tokenHash] });
      byHash.set(tokenHash, session);
      return token;
    },
    byToken: (token) => byHash.get(hashToken(token)),
    byId: (id) => sessions.get(id),
    list: (owner) => [...sessions.values()].filter((s) => s.owner === owner),
    all: () => [...sessions.values()],
    renameDevice(owner, device) {
      for (const session of sessions.values()) {
        if (session.owner !== owner) continue;
        commit(session, { device });
      }
    },
    update: commit,
    hasChat(session, chat) {
      const number = Number(CHAT_PATTERN.exec(String(chat))?.[1]);
      return number >= 1 && number <= session.chatCount;
    },
    newChat(session) {
      const chatCount = session.chatCount + 1;
      commit(session, { chatCount, chat: `${CHAT_PREFIX}${chatCount}` });
      return session.chat;
    },
    // The oldest events go first, past the count or the byte budget of the session.
    addEvent(session, type, data, chat = session.chat) {
      const event = { seq: session.seq + 1, type, data, at: Date.now(), chat };
      const size = byteSize(event);
      if (size > MAX_EVENT_BYTES) throw new TooLarge(`event too large: ${size} bytes, at most ${MAX_EVENT_BYTES}`);
      const { sizes, total } = sizesOf(session);
      let dropped = Math.max(0, session.events.length + 1 - MAX_EVENTS_PER_SESSION);
      let kept = total + size - sizes.slice(0, dropped).reduce((sum, item) => sum + item, 0);
      while (kept > maxSessionEventBytes && dropped < sizes.length) {
        kept -= sizes[dropped];
        dropped += 1;
      }
      commit(session, { seq: event.seq, events: [...session.events.slice(dropped), event], lastAt: event.at });
      eventSizes.set(session, { sizes: [...sizes.slice(dropped), size], total: kept });
      return event;
    },
    revoke(session) {
      sessions.delete(session.id);
      for (const hash of session.tokenHashes) byHash.delete(hash);
      fs.rmSync(sessionFile(session.id), { force: true });
      for (const id of [...filesOf(session.id).keys()]) removeFile(session.id, id);
    },
    // The oldest files of the session go first, past its count or byte quota.
    putFile({ session, name, type, body }) {
      if (body.length > maxSessionFileBytes) throw new TooLarge(`file over the session quota of ${maxSessionFileBytes} bytes`);
      const files = filesOf(session);
      let bytes = [...files.values()].reduce((sum, size) => sum + size, 0) + body.length;
      for (const [oldId, size] of [...files]) {
        if (files.size < maxSessionFiles && bytes <= maxSessionFileBytes) break;
        removeFile(session, oldId);
        bytes -= size;
      }
      const id = newId();
      lastFileAt = Math.max(Date.now(), lastFileAt + 1);
      writeAtomic(fileBody(id), body);
      try {
        writeAtomic(fileMeta(id), JSON.stringify({ id, session, name, type, size: body.length, at: lastFileAt }));
      } catch (error) {
        fs.rmSync(fileBody(id), { force: true });
        throw error;
      }
      indexFile(session, id, body.length);
      return { id };
    },
    getFile(id, sessionId) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
      const meta = readJsonIfPresent(fileMeta(id));
      if (meta?.session !== sessionId) return null;
      return { ...meta, body: fs.readFileSync(fileBody(id)) };
    },
    sweepFiles(now = Date.now()) {
      for (const { id, meta } of fileRecords()) {
        if (now - meta.at > FILE_RETENTION_MS) removeFile(meta.session, id);
      }
    },
    listPatches: () => patches,
    putPatch(patch) {
      const saved = { ...patch, id: patch.id || newId(), updatedAt: Date.now() };
      savePatches([...patches.filter((p) => p.id !== saved.id), saved]);
      return saved;
    },
    deletePatch(id) {
      savePatches(patches.filter((p) => p.id !== id));
    },
  };
}

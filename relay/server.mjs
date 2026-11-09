import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAiSurface } from './server/ai-surface.mjs';
import { createBrowserMethods } from './server/browser-methods.mjs';
import { attachBrowserSocket } from './server/browser-socket.mjs';
import { createBrowsers } from './server/browsers.mjs';
import { createChats } from './server/chats.mjs';
import { createEventFeed } from './server/event-feed.mjs';
import { createHttpHandler } from './server/http-routes.mjs';
import { startMaintenance } from './server/maintenance.mjs';
import { DEFAULT_HOST, serverAddresses, trustedPeer } from './server/network.mjs';
import { createPairing } from './server/pairing.mjs';
import { createPresence } from './server/presence.mjs';
import { createSessionFiles } from './server/session-files.mjs';
import { createSessionRoutes } from './server/session-routes.mjs';
import { createSessions } from './server/sessions.mjs';
import { openCredentials, openStore, writeServerInfo } from './store.mjs';

export { clientAddress, isLoopback, trustedPeer } from './server/network.mjs';

const POLL_FRESH_MS = 70000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
// build.mjs inlines these two reads, since the bundle has nothing next to it.
const INSTRUCTIONS = fs.readFileSync(path.join(HERE, 'instructions.md'), 'utf8');
export const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
// Bundled, the running file is the bundle itself under whatever name it was saved; from source it is the build output.
const BUNDLE_FILE = typeof __TWEAKLINE_BUNDLED__ === 'undefined' ? path.join(HERE, 'dist', 'tweakline.cjs') : fileURLToPath(import.meta.url);

export function startRelay({ port, host = DEFAULT_HOST, dataDir, domain, version = PACKAGE_VERSION, advertiseLocal = true, trustProxy = false, pollFreshMs = POLL_FRESH_MS }) {
  const store = openStore(dataDir);
  const credentials = openCredentials(dataDir);
  const addresses = [];
  const browsers = createBrowsers();
  const presence = createPresence({ pollFreshMs, toOwner: browsers.toOwner });
  const events = createEventFeed({ store, toOwner: browsers.toOwner });
  const sessions = createSessions({ store, credentials, presence, addresses });
  const chats = createChats({ store, events });
  const sessionFiles = createSessionFiles(store);
  const ai = createAiSurface({ store, sessions, events, chats, presence, browsers, sessionFiles });

  const server = http.createServer(createHttpHandler({
    version,
    addresses,
    bundleFile: BUNDLE_FILE,
    credentials,
    aiById: ai.byId,
    pair: createPairing({ credentials, isTrustedPeer: trustedPeer({ domain, trustProxy }), addresses }),
    serveSession: createSessionRoutes({ store, sessions, ai: ai.session, sessionFiles, instructions: INSTRUCTIONS, addresses }),
  }));
  const socket = attachBrowserSocket(server, { store, credentials, browsers, methods: createBrowserMethods({ store, credentials, sessions, events, chats, sessionFiles }) });
  const stopMaintenance = startMaintenance({ store, credentials, sessions, browsers, presence });

  credentials.sweepPairCodes();
  sessions.sweepOrphans();

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      stopMaintenance();
      reject(error);
    });
    server.listen(port, host, () => {
      const listening = server.address();
      addresses.push(...serverAddresses({ host, port: listening.port, domain, advertiseLocal }));
      writeServerInfo(dataDir, { addresses });
      resolve({
        port: listening.port,
        host: listening.address,
        addresses,
        createPairCode: () => credentials.createPairCode(),
        close: () => new Promise((done) => {
          stopMaintenance();
          socket.terminateAll();
          browsers.failPending(null, 'relay stopped');
          events.releaseAll();
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

import { CLOSE_CODES } from './browser-socket.mjs';

const PING_INTERVAL_MS = 20000;
const SWEEP_INTERVAL_MS = 3600 * 1000;
const PRESENCE_CHECK_MS = 10000;

function sweep({ store, credentials, sessions }) {
  store.sweepFiles();
  credentials.sweepPairCodes();
  sessions.sweepOrphans();
}

// Keepalive pings, hourly cleanup, and dropping browsers and AIs that went away.
export function startMaintenance({ store, credentials, sessions, browsers, presence }) {
  const pingTimer = setInterval(() => {
    for (const browser of browsers.all()) browsers.send(browser, { type: 'ping' });
  }, PING_INTERVAL_MS);
  const sweepTimer = setInterval(() => sweep({ store, credentials, sessions }), SWEEP_INTERVAL_MS);
  const presenceTimer = setInterval(() => {
    for (const browser of browsers.all()) {
      if (!credentials.deviceExists(browser.id)) { browser.ws.close(CLOSE_CODES.unauthorized, 'unauthorized'); continue; }
      for (const session of store.list(browser.id)) presence.markOffline(session);
    }
  }, PRESENCE_CHECK_MS);

  return function stop() {
    clearInterval(pingTimer);
    clearInterval(sweepTimer);
    clearInterval(presenceTimer);
    presence.stop();
  };
}

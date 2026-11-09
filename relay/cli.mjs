#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStdioBridge } from './mcp.mjs';
import { isLoopback, PACKAGE_VERSION, startRelay } from './server.mjs';
import { openCredentials, preferredAddress, readServerInfo } from './store.mjs';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const TOOL_DIR = path.resolve(HERE, '..');
const EXTENSION_DIR = path.join(TOOL_DIR, 'extension');
const DEFAULT_PORT = 8787;
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const PROBE_TIMEOUT_MS = 1500;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const KIND_COLUMN_WIDTH = 6;
const RELEASE_SERVER_URL = 'https://github.com/vadzimsharai/tweakline/releases/latest/download/tweakline-server.js';
const UPDATE_TIMEOUT_MS = 120000;
const SCRIPT_HEADER = '#!/usr/bin/env node';
const EXECUTABLE_BITS = 0o777;
const BUNDLED = typeof __TWEAKLINE_BUNDLED__ !== 'undefined';
const PACK_EXCLUDED = /(^|\/)(test|node_modules)(\/|$)|(^|\/)package(-lock)?\.json$/;
const USAGE = `tweakline: server, MCP and packaging for the Tweakline extension
  node tweakline-server.js   same as tweakline serve
  tweakline serve [--domain D] [--port ${DEFAULT_PORT}] [--host H] [--data DIR] [--no-local] [--no-pair-link] [--trust-proxy]
                            run the server, print its addresses and a pair link;
                            --no-local hides the local address behind a proxy,
                            --no-pair-link keeps the secret out of container logs,
                            --trust-proxy takes the client address from X-Forwarded-For
                            sent by a proxy on a private network (10/8, 172.16/12,
                            192.168/16, fc00::/7, loopback), such as a container bridge
  tweakline pair [--data DIR]  print a new one-time pair link for the running server
  tweakline token new --name X [--data DIR]
                            make an MCP token for the whole server, shown once
  tweakline token ls [--data DIR]
                            list MCP tokens and paired browsers
  tweakline token revoke <id> [--data DIR]
                            revoke an MCP token or a paired browser with its sessions
  tweakline mcp               MCP over stdio, uses ~/.config/tweakline/config.json or TWEAKLINE_URL, TWEAKLINE_TOKEN
  tweakline status [--url U] [--data DIR]
                            check the server's addresses
  tweakline pack              build tweakline-extension.zip of the extension, no secrets inside
  tweakline update            replace this single-file server with the latest release;
                            restart the server afterwards. From a source checkout use git pull`;

class UsageError extends Error {}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const dataDir = () => option('data') || path.join(os.homedir(), '.local', 'share', 'tweakline');
const configFile = () => path.join(os.homedir(), '.config', 'tweakline', 'config.json');
const serverUrl = (dir) => {
  const addresses = readServerInfo(dir)?.addresses;
  return addresses?.length ? preferredAddress(addresses).url : DEFAULT_URL;
};
const pairLink = (url, code) => `${url}/pair#${code}`;

// Hints name the command the way this file was started: the single file has no `tweakline` on the PATH.
function selfCommand() {
  const started = process.argv[1] ?? '';
  if (!BUNDLED || !/\.c?js$/.test(started)) return 'tweakline';
  const relative = path.relative(process.cwd(), started);
  return `node ${relative.startsWith('..') ? started : relative}`;
}

async function serve() {
  const relay = await startRelay({
    port: Number(option('port') ?? DEFAULT_PORT),
    host: option('host'),
    dataDir: dataDir(),
    domain: option('domain'),
    advertiseLocal: !flag('no-local'),
    trustProxy: flag('trust-proxy'),
  }).catch((error) => {
    if (error.code === 'EADDRINUSE') throw new UsageError(`port ${option('port') ?? DEFAULT_PORT} is in use: is a server already running? Try ${selfCommand()} status`);
    throw error;
  });
  const stop = () => relay.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(`tweakline ${PACKAGE_VERSION}`);
  for (const { kind, url } of relay.addresses) console.log(`  ${kind}: ${url}`);
  if (!relay.addresses.some((address) => address.kind === 'public') && isLoopback(relay.host)) console.log('  Reachable from this machine only: a phone needs --domain behind a TLS proxy or a tunnel.');
  if (flag('no-pair-link')) console.log(`  pair: run \`${selfCommand()} pair\``);
  else console.log(`  pair: ${pairLink(preferredAddress(relay.addresses).url, relay.createPairCode())}`);
}

function writeConfigOnce(url, token) {
  const file = configFile();
  if (fs.existsSync(file)) {
    console.error(`${file} exists and was left as it is`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    fs.writeFileSync(file, JSON.stringify({ url, token }), { mode: PRIVATE_FILE_MODE });
    console.error(`${selfCommand()} mcp will use this token: wrote ${file}`);
  } catch (error) {
    console.error(`could not write ${file}: ${error.message}`);
  }
}

function tokenCommand() {
  const credentials = openCredentials(dataDir());
  switch (args[1]) {
    case 'new': {
      const name = option('name');
      if (!name) throw new UsageError('token new needs --name X');
      const { token } = credentials.createMcpToken(name);
      writeConfigOnce(serverUrl(dataDir()), token);
      console.log(token);
      return;
    }
    case 'ls':
      for (const { id, kind, name, createdAt } of credentials.list()) {
        console.log(`${id}  ${kind.padEnd(KIND_COLUMN_WIDTH)}  ${name}  ${new Date(createdAt).toISOString()}`);
      }
      return;
    case 'revoke': {
      const kind = args[2] && credentials.revoke(args[2]);
      if (!kind) throw new UsageError(`unknown id: ${args[2] ?? ''}`);
      console.log(`revoked ${kind} ${args[2]}`);
      return;
    }
    default:
      throw new UsageError(USAGE);
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function mcpCommand() {
  const config = readConfig();
  const url = process.env.TWEAKLINE_URL || config.url;
  const token = process.env.TWEAKLINE_TOKEN || config.token;
  if (!url || !token) throw new UsageError(`No server configured: run ${selfCommand()} token new --name X, or set TWEAKLINE_URL and TWEAKLINE_TOKEN`);
  await runStdioBridge({ url: url.replace(/\/+$/, ''), token, version: PACKAGE_VERSION });
}

async function probe(url) {
  try {
    const res = await fetch(`${url}/tweakline`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const info = res.ok ? await res.json() : null;
    return info?.name === 'tweakline' ? `tweakline ${info.version}` : 'not a tweakline server';
  } catch {
    return 'unreachable';
  }
}

async function status() {
  const known = readServerInfo(dataDir())?.addresses?.map((a) => a.url) ?? [DEFAULT_URL];
  const urls = [...new Set([...known, ...(option('url') ? [option('url').replace(/\/+$/, '')] : [])])];
  for (const url of urls) console.log(`${url}: ${await probe(url)}`);
}

function pack() {
  if (!fs.existsSync(EXTENSION_DIR)) throw new UsageError('pack works only from a checkout of the repository');
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakline-pack-'));
  const out = path.join(buildDir, 'tweakline');
  fs.cpSync(EXTENSION_DIR, out, { recursive: true, filter: (p) => !PACK_EXCLUDED.test(path.relative(EXTENSION_DIR, p).split(path.sep).join('/')) });
  const zip = path.join(buildDir, 'tweakline-extension.zip');
  execFileSync('zip', ['-qr', zip, 'tweakline'], { cwd: buildDir });
  return zip;
}

// The new file is written next to the running one and renamed over it, so a failed download changes nothing.
async function update() {
  if (!BUNDLED) throw new UsageError('tweakline runs from a source checkout here: update it with git pull');
  const file = fs.realpathSync(fileURLToPath(import.meta.url));
  // Tests point this at a local server; it is not a documented setting.
  const url = process.env.TWEAKLINE_TEST_UPDATE_URL || RELEASE_SERVER_URL;
  let body;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    throw new UsageError(`download of ${url} failed: ${error.message}`);
  }
  if (!body.subarray(0, SCRIPT_HEADER.length).equals(Buffer.from(SCRIPT_HEADER))) throw new UsageError(`${url} is not a tweakline server file, ${file} left as it was`);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, body);
    fs.chmodSync(temp, fs.statSync(file).mode & EXECUTABLE_BITS);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  console.log(`updated ${file}; restart the server to run the new version`);
}

const startsServer = args.length === 0 || (args[0].startsWith('--') && args[0] !== '--help');

async function main() {
  if (startsServer) return serve();
  switch (args[0]) {
    case 'serve': return serve();
    case '--help':
    case 'help':
      console.log(USAGE);
      return undefined;
    case 'pair': {
      const code = openCredentials(dataDir()).createPairCode();
      console.log(pairLink(serverUrl(dataDir()), code));
      return undefined;
    }
    case 'token': return tokenCommand();
    case 'mcp': return mcpCommand();
    case 'status': return status();
    case 'update': return update();
    case 'pack':
      console.log(pack());
      return undefined;
    case undefined:
      console.log(USAGE);
      return undefined;
    default:
      throw new UsageError(USAGE);
  }
}

main().catch((error) => {
  console.error(error instanceof UsageError ? error.message : error);
  process.exitCode = 1;
});

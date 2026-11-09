import { preferredAddress } from '../store.mjs';

export const DEFAULT_HOST = '127.0.0.1';
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);
const LOOPBACK_PATTERN = /^(127\.|::1$|::ffff:127\.)/;
const PRIVATE_IPV4_PATTERN = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IPV6_PATTERN = /^(::1$|f[cd][0-9a-f]{0,2}:)/i;
const IPV4_MAPPED_PREFIX = '::ffff:';

export const isLoopback = (address) => LOOPBACK_PATTERN.test(address ?? '');

function isPrivateAddress(address = '') {
  const ipv4 = address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) ? address.slice(IPV4_MAPPED_PREFIX.length) : address;
  return PRIVATE_IPV4_PATTERN.test(ipv4) || PRIVATE_IPV6_PATTERN.test(address);
}

// --trust-proxy covers a proxy on a private network, such as a container bridge; otherwise only a proxy on
// this machine, declared by --domain, can vouch for a client.
export function trustedPeer({ domain, trustProxy }) {
  if (trustProxy) return isPrivateAddress;
  return domain ? isLoopback : () => false;
}

// The rightmost entry is the one the trusted proxy appended.
export function clientAddress(req, isTrustedPeer) {
  const peer = req.socket.remoteAddress;
  if (!isTrustedPeer(peer)) return peer;
  return req.headers['x-forwarded-for']?.split(',').at(-1).trim() || peer;
}

function localAddress(host, port) {
  const name = WILDCARD_HOSTS.has(host) ? DEFAULT_HOST : host;
  return `http://${name.includes(':') ? `[${name}]` : name}:${port}`;
}

const publicDomain = (domain) => domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

export function serverAddresses({ host, port, domain, advertiseLocal }) {
  const addresses = domain && !advertiseLocal ? [] : [{ kind: 'local', url: localAddress(host, port) }];
  if (domain) addresses.push({ kind: 'public', url: `https://${publicDomain(domain)}` });
  return addresses;
}

// The address the client used, so links handed to it work from where it is.
export const baseFor = (addresses, req) => (addresses.find((a) => new URL(a.url).host === req.headers.host) ?? preferredAddress(addresses)).url;

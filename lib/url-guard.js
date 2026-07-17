'use strict';

/**
 * SSRF guard for team-submitted URLs.
 *
 * The Listing Intake form lets team members paste ANY URL, which the intake
 * importer then fetches (plain node-fetch first, a real Chrome as fallback).
 * Without a guard, a submitted URL pointing at an internal host — a metadata
 * endpoint, an admin panel on the LAN, localhost — would be fetched with the
 * importer's network position. assertPublicUrl blocks that by rejecting any
 * URL that targets a loopback / private / link-local / CGNAT / reserved /
 * multicast address, for both IPv4 and IPv6 (including IPv4-mapped IPv6), and
 * any hostname that RESOLVES to one.
 *
 * Residual limitation (deliberate non-goal): node-fetch follows HTTP
 * redirects, and we validate only the original URL, not each redirect hop. A
 * public URL that 30x-redirects to an internal address would still be
 * followed. Per-hop re-validation (a custom redirect-disabled agent that
 * re-checks every Location) is intentionally out of scope for this low-volume,
 * team-facing form; the value here is stopping the obvious direct-internal
 * submission, not building a hardened proxy.
 */

const dns = require('dns').promises;
const net = require('net');

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

// CIDR blocks that must never be fetched (RFC 1918 private, loopback,
// link-local, CGNAT/RFC 6598, IETF/documentation/benchmark reserved,
// multicast, and the "this network" / broadcast edges).
const IPV4_BLOCKED = [
  ['0.0.0.0', 8],        // "this network" / unspecified
  ['10.0.0.0', 8],       // RFC 1918 private
  ['100.64.0.0', 10],    // RFC 6598 CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local
  ['172.16.0.0', 12],    // RFC 1918 private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1 documentation
  ['192.168.0.0', 16],   // RFC 1918 private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2 documentation
  ['203.0.113.0', 24],   // TEST-NET-3 documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved (includes 255.255.255.255 broadcast)
];

function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of IPV4_BLOCKED) {
    const baseInt = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((value & mask) >>> 0) === ((baseInt & mask) >>> 0)) return true;
  }
  return false;
}

/** Expand any IPv6 text form (including '::' and embedded IPv4) to 16 bytes. */
function ipv6ToBytes(input) {
  let ip = input.split('%')[0]; // drop zone id

  // Embedded IPv4 tail, e.g. "::ffff:192.168.1.1"
  if (ip.includes('.')) {
    const cut = ip.lastIndexOf(':');
    const v4 = ipv4ToInt(ip.slice(cut + 1));
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    ip = `${ip.slice(0, cut + 1)}${high}:${low}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  let groups;
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const word = parseInt(group, 16);
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function isBlockedIpv6(ip) {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return false;

  // IPv4-mapped (::ffff:a.b.c.d) — evaluate the embedded IPv4 instead.
  const isV4Mapped = bytes.slice(0, 10).every(b => b === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  // NAT64 (64:ff9b::/96) — also carries an embedded IPv4.
  const isNat64 = bytes[0] === 0x00 && bytes[1] === 0x64
    && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every(b => b === 0);
  if (isNat64) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  // ::  (unspecified) and ::1 (loopback)
  if (bytes.slice(0, 15).every(b => b === 0) && (bytes[15] === 0 || bytes[15] === 1)) return true;

  if ((bytes[0] & 0xfe) === 0xfc) return true;                 // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (bytes[0] === 0xff) return true;                          // ff00::/8 multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01
    && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;    // 2001:db8::/32 documentation

  return false;
}

function isBlockedAddress(address, family) {
  return family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/**
 * Reject any URL that would fetch an internal / non-public host. Resolves
 * hostnames via DNS and rejects if ANY resolved address is non-public (a
 * host with both a public and a private A record is treated as unsafe).
 *
 * @param {string} url
 * @throws {Error} with a clear, user-facing message when the URL is unsafe.
 */
async function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error(`Not a fetchable URL: "${url}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch non-http(s) URL scheme "${parsed.protocol.replace(/:$/, '')}"`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Refusing to fetch localhost');
  }

  // WHATWG URL keeps IPv6 literals in brackets ("[::1]").
  const literal = hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(literal);
  if (literalFamily !== 0) {
    if (isBlockedAddress(literal, literalFamily)) {
      throw new Error(`Refusing to fetch private/internal address ${literal}`);
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`Could not resolve host "${hostname}": ${err.message}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new Error(`Host "${hostname}" did not resolve to any address`);
  }
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new Error(`Refusing to fetch "${hostname}" — it resolves to private/internal address ${address}`);
    }
  }
}

module.exports = { assertPublicUrl, isBlockedIpv4, isBlockedIpv6 };

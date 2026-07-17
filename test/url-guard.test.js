'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');

const { assertPublicUrl } = require('../lib/url-guard');

// IP literals are used everywhere possible so these cases never touch DNS.

test('assertPublicUrl accepts a public IPv4 literal', async () => {
  await assert.doesNotReject(assertPublicUrl('http://8.8.8.8/listing'));
  await assert.doesNotReject(assertPublicUrl('https://93.184.216.34/'));
});

test('assertPublicUrl rejects loopback 127.0.0.1', async () => {
  await assert.rejects(assertPublicUrl('http://127.0.0.1/'), /private\/internal/);
});

test('assertPublicUrl rejects RFC1918 10.x and 192.168.x', async () => {
  await assert.rejects(assertPublicUrl('http://10.0.0.5/'), /private\/internal/);
  await assert.rejects(assertPublicUrl('http://192.168.1.1/admin'), /private\/internal/);
  await assert.rejects(assertPublicUrl('http://172.16.4.4/'), /private\/internal/);
});

test('assertPublicUrl rejects link-local 169.254.x (cloud metadata)', async () => {
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /private\/internal/);
});

test('assertPublicUrl rejects CGNAT 100.64.x', async () => {
  await assert.rejects(assertPublicUrl('http://100.64.0.1/'), /private\/internal/);
});

test('assertPublicUrl rejects IPv6 loopback ::1', async () => {
  await assert.rejects(assertPublicUrl('http://[::1]/'), /private\/internal/);
});

test('assertPublicUrl rejects IPv6 unique-local fc00::/7', async () => {
  await assert.rejects(assertPublicUrl('http://[fc00::1]/'), /private\/internal/);
  await assert.rejects(assertPublicUrl('http://[fd12:3456::1]/'), /private\/internal/);
});

test('assertPublicUrl rejects IPv6 link-local fe80::/10', async () => {
  await assert.rejects(assertPublicUrl('http://[fe80::1]/'), /private\/internal/);
});

test('assertPublicUrl rejects IPv4-mapped IPv6 pointing at loopback', async () => {
  await assert.rejects(assertPublicUrl('http://[::ffff:127.0.0.1]/'), /private\/internal/);
});

test('assertPublicUrl accepts a public IPv6 literal', async () => {
  await assert.doesNotReject(assertPublicUrl('http://[2606:4700:4700::1111]/'));
});

test('assertPublicUrl rejects the hostname "localhost"', async () => {
  await assert.rejects(assertPublicUrl('http://localhost:8080/'), /localhost/);
  await assert.rejects(assertPublicUrl('http://api.localhost/'), /localhost/);
});

test('assertPublicUrl rejects non-http(s) schemes', async () => {
  await assert.rejects(assertPublicUrl('ftp://example.com/file'), /scheme/);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /scheme/);
});

test('assertPublicUrl rejects a garbage URL', async () => {
  await assert.rejects(assertPublicUrl('not a url'), /fetchable/);
});

// Lookup-based cases: stub dns.promises.lookup so a hostname resolves to a
// controlled address set. url-guard captured require('dns').promises, the same
// object, so overriding .lookup here is observed by the guard.
test('assertPublicUrl rejects a hostname that resolves to a private address', async (t) => {
  const original = dns.promises.lookup;
  t.after(() => { dns.promises.lookup = original; });
  dns.promises.lookup = async () => [{ address: '10.1.2.3', family: 4 }];
  await assert.rejects(assertPublicUrl('http://internal.example.com/'), /resolves to private\/internal/);
});

test('assertPublicUrl rejects when ANY resolved address is private', async (t) => {
  const original = dns.promises.lookup;
  t.after(() => { dns.promises.lookup = original; });
  dns.promises.lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.0.9', family: 4 },
  ];
  await assert.rejects(assertPublicUrl('http://mixed.example.com/'), /resolves to private\/internal/);
});

test('assertPublicUrl accepts a hostname that resolves to public addresses', async (t) => {
  const original = dns.promises.lookup;
  t.after(() => { dns.promises.lookup = original; });
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  await assert.doesNotReject(assertPublicUrl('http://public.example.com/'));
});

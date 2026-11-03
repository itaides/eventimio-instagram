import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt, accessToken, resetAccessCache } from '../src/access.js';
import worker from '../src/index.js';

const TEAM = 'example-team.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const other = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);

async function sign(claims, { kid = 'k1', key = privateKey } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: now() + 600, email: 'owner@example.com' });
const cfg = { team: TEAM, aud: AUD };

let certFetches;
beforeEach(() => {
  resetAccessCache();
  certFetches = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) {
      certFetches++;
      return new Response(JSON.stringify({ keys: [jwk] }));
    }
    return new Response('{}');
  };
});

test('accepts a valid team-signed token and caches the keys', async () => {
  assert.equal((await verifyAccessJwt(await sign(good()), cfg)).email, 'owner@example.com');
  await verifyAccessJwt(await sign(good()), cfg);
  assert.equal(certFetches, 1);
});

test('rejects wrong audience, issuer, expired, unknown key, foreign signature, garbage', async () => {
  assert.equal(await verifyAccessJwt(await sign({ ...good(), aud: ['other-app'] }), cfg), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good(), iss: 'https://evil.cloudflareaccess.com' }), cfg), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good(), exp: now() - 1 }), cfg), null);
  assert.equal(await verifyAccessJwt(await sign(good(), { kid: 'nope' }), cfg), null);
  assert.equal(await verifyAccessJwt(await sign(good(), { key: other.privateKey }), cfg), null);
  assert.equal(await verifyAccessJwt('a.b.c', cfg), null);
  assert.equal(await verifyAccessJwt(null, cfg), null);
});

test('rejects alg none', async () => {
  const h = b64url(JSON.stringify({ alg: 'none', kid: 'k1' }));
  assert.equal(await verifyAccessJwt(`${h}.${b64url(JSON.stringify(good()))}.`, cfg), null);
});

test('reads the token from the header or the CF_Authorization cookie', () => {
  assert.equal(accessToken(new Request('https://x', { headers: { 'Cf-Access-Jwt-Assertion': 'h' } })), 'h');
  assert.equal(accessToken(new Request('https://x', { headers: { Cookie: 'a=1; CF_Authorization=c; b=2' } })), 'c');
  assert.equal(accessToken(new Request('https://x')), null);
});

test('worker: with Access configured, admin needs the token and never asks for a password', async () => {
  const env = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ADMIN_PASSWORD: 'pw', DB: null };
  const noToken = await worker.fetch(new Request('https://ig.example.com/admin', {
    headers: { Authorization: `Basic ${btoa('a:pw')}` },
  }), env, { waitUntil() {} });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.headers.get('WWW-Authenticate'), null);

  const forged = await worker.fetch(new Request('https://ig.example.com/', {
    headers: { 'Cf-Access-Jwt-Assertion': await sign(good(), { key: other.privateKey }) },
  }), env, { waitUntil() {} });
  assert.equal(forged.status, 403);
});

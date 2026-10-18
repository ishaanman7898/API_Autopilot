import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashRuleSet, isSunset } from '../src/rule.js';
import { TrustError, generateKeys, signRuleSet, verifyRuleSet } from '../src/signing.js';
import { fetchKeySet, loadKeySetFile, parseKeySet } from '../src/keys.js';
import { ruleSet } from './fixtures/match-cases.js';

const rules = () => ruleSet([{ id: 'm', kind: 'rename-method', match: { call: 'a.b' }, transform: { to: 'c.d' } }]);
const setup = (keyId = 'k1') => {
  const keys = generateKeys();
  return { ...keys, keyId, signed: signRuleSet(rules(), keys.privatePem, keyId), published: [{ keyId, publicKey: keys.publicPem }] };
};
const reason = (rs, keys, now) => verifyRuleSet(rs, keys, now).reason;

test('a signed rule verifies and any edit breaks it', () => {
  const { signed, published } = setup();
  assert.equal(verifyRuleSet(signed, published).ok, true);
  const body = structuredClone(signed);
  body.rules[0].transform.to = 'evil.run';
  assert.match(reason(body, published), /does not match signed hash/);
  const rehashed = structuredClone(body);
  rehashed.signature.hash = hashRuleSet(body);
  assert.equal(reason(rehashed, published), 'bad signature');
  const sig = structuredClone(signed);
  sig.signature.sig = Buffer.alloc(64).toString('base64');
  assert.equal(reason(sig, published), 'bad signature');
  const extra = structuredClone(signed);
  extra.sunset = '2100-01-01';
  assert.match(reason(extra, published), /does not match signed hash/);
});

test('unsigned, malformed and unsupported signature blocks are refused', () => {
  const { signed, published } = setup();
  assert.equal(reason(rules(), published), 'unsigned');
  assert.match(reason({ ...signed, signature: { ...signed.signature, alg: 'none' } }, published), /unsupported alg/);
  assert.match(reason({ ...signed, signature: { alg: 'ed25519' } }, published), /malformed/);
  assert.equal(reason({ ...signed, signature: 'x' }, published), 'unsigned');
});

test('a signature cannot be moved to another published key id', () => {
  const a = setup('a');
  const b = generateKeys();
  const published = [...a.published, { keyId: 'b', publicKey: b.publicPem }];
  const swapped = { ...a.signed, signature: { ...a.signed.signature, keyId: 'b' } };
  assert.equal(reason(swapped, published), 'bad signature');
  assert.match(reason(a.signed, [{ keyId: 'other', publicKey: a.publicPem }]), /no published key/);
});

test('key windows: expired, not yet valid and revoked keys fail closed', () => {
  const { signed, publicPem } = setup();
  const now = new Date('2026-06-01T00:00:00Z');
  const key = (extra) => [{ keyId: 'k1', publicKey: publicPem, ...extra }];
  assert.equal(verifyRuleSet(signed, key({ notBefore: '2026-01-01', expires: '2027-01-01' }), now).ok, true);
  assert.equal(reason(signed, key({ expires: '2026-05-31' }), now), 'key has expired');
  assert.equal(reason(signed, key({ expires: '2026-06-01T00:00:00Z' }), now), 'key has expired');
  assert.equal(reason(signed, key({ notBefore: '2026-07-01' }), now), 'key is not valid yet');
  assert.equal(reason(signed, key({ revoked: true }), now), 'key is revoked');
  assert.equal(reason(signed, key({ expires: 'garbage' }), now), 'key has expired');
});

test('rotation: rules signed by a retired key must be re-signed', () => {
  const oldKeys = generateKeys();
  const newKeys = generateKeys();
  const oldRule = signRuleSet(rules(), oldKeys.privatePem, 'k1');
  const published = [
    { keyId: 'k1', publicKey: oldKeys.publicPem, revoked: true },
    { keyId: 'k2', publicKey: newKeys.publicPem },
  ];
  assert.equal(reason(oldRule, published), 'key is revoked');
  assert.equal(verifyRuleSet(signRuleSet(rules(), newKeys.privatePem, 'k2'), published).ok, true);
});

test('duplicate key ids and wrong key types are refused', () => {
  const { signed, publicPem } = setup();
  assert.match(reason(signed, [{ keyId: 'k1', publicKey: publicPem }, { keyId: 'k1', publicKey: publicPem }]), /more than once/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.match(reason(signed, [{ keyId: 'k1', publicKey: rsa }]), /not ed25519/);
  assert.match(reason(signed, [{ keyId: 'k1', publicKey: 'not a key' }]), /unreadable/);
});

test('key set parsing rejects bad shapes', () => {
  const { publicPem } = setup();
  assert.throws(() => parseKeySet({}), TrustError);
  assert.throws(() => parseKeySet({ keys: [] }), TrustError);
  assert.throws(() => parseKeySet({ keys: [{ publicKey: publicPem }] }), /no keyId/);
  assert.throws(() => parseKeySet({ keys: [{ keyId: 'a', publicKey: publicPem }, { keyId: 'a', publicKey: publicPem }] }), /duplicated/);
  assert.throws(() => parseKeySet({ keys: [{ keyId: 'a', publicKey: publicPem, expires: 'soon' }] }), /not a date/);
  assert.throws(() => parseKeySet({ keys: [{ keyId: 'a', publicKey: 'x' }] }), /usable ed25519/);
  assert.equal(parseKeySet({ keys: [{ keyId: 'a', publicKey: publicPem }] }).length, 1);
});

test('key files: missing, truncated and pem', () => {
  const { publicPem } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const json = join(dir, 'keys.json');
  writeFileSync(json, JSON.stringify({ keys: [{ keyId: 'a', publicKey: publicPem }] }).slice(0, 40));
  assert.throws(() => loadKeySetFile(json), TrustError);
  assert.throws(() => loadKeySetFile(join(dir, 'missing.json')), TrustError);
  const pem = join(dir, 'k.pem');
  writeFileSync(pem, publicPem);
  assert.equal(loadKeySetFile(pem, 'k1')[0].keyId, 'k1');
  const truncated = join(dir, 't.pem');
  writeFileSync(truncated, publicPem.slice(0, 60));
  const { signed } = setup('k1');
  assert.match(reason(signed, loadKeySetFile(truncated, 'k1')), /unreadable/);
});

const reply = (body, init = {}) => async () => new Response(body, init);

test('well known fetch fails closed on every error', async () => {
  const { publicPem } = setup();
  const good = JSON.stringify({ keys: [{ keyId: 'k1', publicKey: publicPem }] });
  assert.equal((await fetchKeySet('api.acme.com', { fetchImpl: reply(good) })).length, 1);
  const fails = [
    ['network error', async () => { throw new TypeError('fetch failed'); }, /could not fetch/],
    ['redirect refused', async () => { throw new TypeError('redirect mode is set to error'); }, /could not fetch/],
    ['404', reply('nope', { status: 404 }), /HTTP 404/],
    ['500', reply('oops', { status: 500 }), /HTTP 500/],
    ['not json', reply('<html>'), /not valid JSON/],
    ['empty key set', reply('{"keys":[]}'), /no keys/],
    ['too large', reply('x'.repeat(70000)), /larger than/],
    ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError'); }, /could not fetch/],
  ];
  for (const [name, fetchImpl, re] of fails) {
    await assert.rejects(fetchKeySet('api.acme.com', { fetchImpl }), re, name);
  }
  for (const host of ['localhost', 'evil.com/path', 'a b.com', 'user@evil.com', '', 'https://api.acme.com']) {
    await assert.rejects(fetchKeySet(host, { fetchImpl: reply(good) }), /valid host name/, host);
  }
});

test('sunset dates, with an injected clock', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(isSunset({ sunset: '2026-05-31' }, now), true);
  assert.equal(isSunset({ sunset: '2026-06-01' }, now), true);
  assert.equal(isSunset({ sunset: '2026-06-02' }, now), false);
  assert.equal(isSunset({ sunset: 'tomorrow' }, now), true);
  assert.equal(isSunset({}, now), true);
});

test('canonical form is order independent and refuses values JSON cannot carry', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.throws(() => canonical({ a: undefined }));
  assert.throws(() => canonical({ a: NaN }));
  assert.throws(() => canonical({ a: () => 1 }));
  assert.notEqual(canonical({ a: '1' }), canonical({ a: 1 }));
});

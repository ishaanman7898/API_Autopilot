import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../src/cli.js';
import { withDefaults } from '../src/config.js';
import { findUpgrades, lineOf, rangeLine } from '../src/registry.js';
import { generateKeys, signRuleSet } from '../src/signing.js';
import { parseSources, signedRulesFor } from '../src/sources.js';

// A fake fetch that serves a fixed map of URL to JSON or text, and 404 for anything else.
export function fakeFetch(routes, seen = []) {
  return async (url) => {
    seen.push(url);
    if (!(url in routes)) return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' };
    const body = routes[url];
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

const R = 'https://registry.npmjs.org';
const doc = (latest, versions, deprecated = {}) => ({ 'dist-tags': { latest }, versions: Object.fromEntries(versions.map((v) => [v, deprecated[v] ? { deprecated: deprecated[v] } : {}])) });
export const registryRoutes = {
  [`${R}/acme-sdk`]: doc('2.1.0', ['1.0.0', '1.4.0', '1.4.1', '2.0.0', '2.1.0', '3.0.0-beta.1']),
  [`${R}/@scope%2Ftool`]: doc('0.9.0', ['0.8.0', '0.8.3', '0.9.0'], { '0.9.0': 'renamed to @scope/new-tool' }),
  [`${R}/stable`]: doc('5.2.0', ['5.0.0', '5.2.0']),
  [`${R}/next-only`]: doc('4.0.0-rc.1', ['3.0.0', '4.0.0-rc.1']),
};

test('version lines and dependency ranges', () => {
  assert.equal(lineOf('14.1.1'), '14');
  assert.equal(lineOf('0.44.2'), '0.44');
  assert.equal(lineOf('nope'), null);
  const cases = [
    ['^14.1.1', '14'], ['~14.0.0', '14'], ['14.1.1', '14'], ['14.x', '14'], ['>=14 <16', '14'], ['v2.0.0', '2'],
    ['^0.44.0', '0.44'], ['0.x', null], ['*', null], ['latest', null], ['workspace:*', null], ['file:../x', null],
    ['github:user/repo', null], ['user/repo', null], ['https://x.test/a.tgz', null], ['git+https://x.test/r.git', null],
  ];
  for (const [range, line] of cases) assert.equal(rangeLine('p', range)?.line ?? null, line, range);
  assert.deepEqual(rangeLine('alias', 'npm:@real/pkg@^3.1.0'), { target: '@real/pkg', line: '3' });
});

test('findUpgrades reports new major lines, newest on the current line, and deprecations', async () => {
  const manifests = {
    'package.json': JSON.stringify({ dependencies: { 'acme-sdk': '^1.4.0', stable: '^5.0.0', 'next-only': '^3.0.0' }, devDependencies: { '@scope/tool': '^0.8.0' } }),
    'packages/web/package.json': JSON.stringify({ dependencies: { 'acme-sdk': '~1.0.0', missing: '^1.0.0' } }),
    'broken/package.json': '{ not json',
  };
  const { upgrades, skipped } = await findUpgrades(manifests, { fetchImpl: fakeFetch(registryRoutes) });
  assert.deepEqual(upgrades.map((u) => [u.package, u.from, u.to, u.manifests.map((m) => m.file)]), [
    ['@scope/tool', '0.8.3', '0.9.0', ['package.json']],
    ['acme-sdk', '1.4.1', '2.1.0', ['package.json', 'packages/web/package.json']],
  ]);
  assert.equal(upgrades[0].deprecated, 'renamed to @scope/new-tool');
  assert.deepEqual(skipped.map((s) => s.package), ['missing']);
  const only = await findUpgrades(manifests, { fetchImpl: fakeFetch(registryRoutes), only: ['acme-sdk'] });
  assert.deepEqual(only.upgrades.map((u) => u.package), ['acme-sdk']);
});

export function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'watch-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

export async function cli(argv, fetchImpl) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), fetch: fetchImpl });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('watch prints upgrades, writes a plan, and writes nothing on a dry run', async () => {
  const dir = repoWith({ 'package.json': JSON.stringify({ dependencies: { 'acme-sdk': '^1.4.0', stable: '^5.0.0' } }), '.apimigrate.yml': 'watch:\n- acme-sdk\n- stable\n' });
  const dry = await cli(['watch', '--root', dir, '--dry-run'], fakeFetch(registryRoutes));
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /acme-sdk: 1\.4\.1 -> 2\.1\.0 in package\.json/);
  assert.equal(existsSync(join(dir, '.apimigrate')), false);
  const real = await cli(['watch', '--root', dir], fakeFetch(registryRoutes));
  assert.equal(real.code, 0, real.err);
  const plan = JSON.parse(readFileSync(join(dir, '.apimigrate/watch/plan.json'), 'utf8'));
  assert.equal(plan.schema, 'apimigrate-watch/1');
  assert.deepEqual(plan.upgrades.map((u) => [u.package, u.source]), [['acme-sdk', 'none']]);
  const none = await cli(['watch', '--root', repoWith({ 'package.json': JSON.stringify({ dependencies: { stable: '^5.0.0' } }) }), '--dry-run'], fakeFetch(registryRoutes));
  assert.match(none.out, /no dependency has a new major version/);
});

const DOMAIN = 'acme.example';
const ruleFor = (pkg = 'acme-sdk', provider = 'acme') => ({
  schema: 'apimigrate/1', provider, package: pkg, id: `${pkg}-1-to-2`, from: '1.x', to: '2.x', sunset: '2099-01-01',
  rules: [{ id: 'm', kind: 'rename-method', match: { call: 'charges.create' }, transform: { to: 'payments.create' } }],
});
function providerRoutes({ ruleSet = ruleFor(), signer = generateKeys(), publish = signer, index = true } = {}) {
  const signed = signRuleSet(ruleSet, signer.privatePem, 'k1');
  return {
    signed,
    routes: {
      ...registryRoutes,
      ...(index ? { [`https://${DOMAIN}/.well-known/apimigrate-rules.json`]: { rules: [{ package: 'acme-sdk', from: '1', to: '2', url: `https://${DOMAIN}/rules/acme-1-to-2.json` }] } } : {}),
      [`https://${DOMAIN}/rules/acme-1-to-2.json`]: signed,
      [`https://${DOMAIN}/.well-known/apimigrate-keys.json`]: { keys: [{ keyId: 'k1', publicKey: publish.publicPem }] },
    },
  };
}
const watched = (extra = '') => repoWith({
  'package.json': JSON.stringify({ dependencies: { 'acme-sdk': '^1.4.0' } }),
  '.apimigrate.yml': `sources:\n- "acme-sdk ${DOMAIN}"\n${extra}`,
});

test('watch fetches a provider rule file, verifies it against the domain keys, and writes it with the keys', async () => {
  const { routes, signed } = providerRoutes();
  const dir = watched();
  const r = await cli(['watch', '--root', dir], fakeFetch(routes));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /acme-sdk: 1\.4\.1 -> 2\.1\.0 in package\.json: signed rules from acme\.example/);
  const plan = JSON.parse(readFileSync(join(dir, '.apimigrate/watch/plan.json'), 'utf8'));
  const [entry] = plan.upgrades;
  assert.equal(entry.source, 'signed');
  assert.equal(entry.rules, '.apimigrate/watch/acme-sdk-1-to-2.rules.json');
  assert.equal(entry.hash, signed.signature.hash);
  const check = await cli(['check', join(dir, entry.rules), '--keys', join(dir, entry.keys)]);
  assert.equal(check.code, 0, check.err);
});

test('watch refuses provider rules that are unsigned by the domain, for another package, not listed, or not allowed', async () => {
  const reasonFor = async (setup, extra) => {
    const dir = watched(extra);
    const r = await cli(['watch', '--root', dir, '--dry-run'], fakeFetch(setup.routes));
    assert.equal(r.code, 0, r.err);
    return r.out;
  };
  assert.match(await reasonFor(providerRoutes({ publish: generateKeys() })), /no usable signed rules from acme\.example: .*bad signature/);
  assert.match(await reasonFor(providerRoutes({ ruleSet: ruleFor('other-sdk') })), /is for other-sdk, not acme-sdk/);
  assert.match(await reasonFor(providerRoutes({ index: false })), /could not fetch https:\/\/acme\.example\/\.well-known\/apimigrate-rules\.json: HTTP 404/);
  assert.match(await reasonFor(providerRoutes(), `pins:\n- ${'0'.repeat(64)}\n`), /is not in the pins list/);
  assert.match(await reasonFor(providerRoutes({ ruleSet: ruleFor('acme-sdk', 'mallory') }), 'providers: [acme]\n'), /provider mallory is not allowed/);
  const bad = await cli(['watch', '--root', repoWith({ 'package.json': '{}', '.apimigrate.yml': 'sources:\n- "acme-sdk"\n' }), '--dry-run'], fakeFetch(registryRoutes));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /must be a package name and a domain/);
});

test('signedRulesFor needs an index entry for the same lines and a rule file before its sunset', async () => {
  const upgrade = { package: 'acme-sdk', line: '1', to: '2.1.0' };
  const cfg = withDefaults({});
  const { routes } = providerRoutes();
  const fetchImpl = fakeFetch(routes);
  assert.equal((await signedRulesFor(upgrade, DOMAIN, { fetchImpl, cfg })).ok, true);
  assert.match((await signedRulesFor({ ...upgrade, to: '3.0.0' }, DOMAIN, { fetchImpl, cfg })).reason, /lists no rules for acme-sdk 1 to 3/);
  assert.match((await signedRulesFor(upgrade, DOMAIN, { fetchImpl, cfg, now: new Date('2100-01-01') })).reason, /sunset/);
  const http = { ...routes, [`https://${DOMAIN}/.well-known/apimigrate-rules.json`]: { rules: [{ package: 'acme-sdk', from: '1', to: '2', url: `http://${DOMAIN}/r.json` }] } };
  assert.match((await signedRulesFor(upgrade, DOMAIN, { fetchImpl: fakeFetch(http), cfg })).reason, /gives no https url/);
  assert.deepEqual([...parseSources(['@mux/mux-node  mux.com'])], [['@mux/mux-node', 'mux.com']]);
  assert.throws(() => parseSources(['acme-sdk https://acme.com']), /must be a package name and a domain/);
});

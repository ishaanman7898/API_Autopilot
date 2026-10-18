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
import { RAW, githubRepo, releaseRefs } from '../src/upstream.js';
import { fetchText } from '../src/net.js';

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

// Two releases of acme-sdk on GitHub in the Stainless api.md layout. 1.4.1 is found by the commit npm recorded,
// 2.1.0 by its tag, and 2.1.0 renamed the package to @acme/sdk and the jobsPreview resource to jobs.
const HEAD = 'a'.repeat(40);
const md = (verb, path, call, args = '') => `- <code title="${verb} ${path}">client.${call.split('.').slice(0, -1).join('.')}.<a href="./src/resources/x.ts">${call.split('.').at(-1)}</a>(${args}) -> Thing</code>`;
function upstreamRoutes({ renamedOnNpm = true } = {}) {
  const tree = (base, ns) => ({
    [`${base}/api.md`]: '# Shared\n\n# [Jobs](src/resources/jobs/api.md)\n# [Missing](src/resources/missing/api.md)\n',
    [`${base}/src/resources/jobs/api.md`]: ['# Jobs', '', md('get', '/jobs', `${ns}.list`), md('post', '/jobs', `${ns}.create`, '{ ...params }'), md('get', '/jobs/{ID}', `${ns}.retrieve`, 'id')].join('\n'),
  });
  return {
    ...registryRoutes,
    [`${R}/acme-sdk/1.4.1`]: { name: 'acme-sdk', version: '1.4.1', gitHead: HEAD, repository: { type: 'git', url: 'git+https://github.com/acme/acme-node.git' } },
    [`${R}/acme-sdk/2.1.0`]: { name: 'acme-sdk', version: '2.1.0', repository: 'github:acme/acme-node' },
    ...(renamedOnNpm ? { [`${R}/@acme%2Fsdk`]: doc('2.1.0', ['2.1.0']) } : {}),
    ...tree(`${RAW}/acme/acme-node/${HEAD}`, 'jobsPreview'),
    [`${RAW}/acme/acme-node/${HEAD}/package.json`]: { name: 'acme-sdk', version: '1.4.1' },
    ...tree(`${RAW}/acme/acme-node/v2.1.0`, 'jobs'),
    [`${RAW}/acme/acme-node/v2.1.0/package.json`]: { name: '@acme/sdk', version: '2.1.0' },
  };
}
const usesAcme = () => repoWith({
  'package.json': JSON.stringify({ dependencies: { 'acme-sdk': '^1.4.0' } }),
  'src/app.ts': "import Acme from 'acme-sdk';\nconst client = new Acme();\nexport const jobs = () => client.jobsPreview.list();\n",
});

test('watch drafts unsigned rules from the api.md of both releases on GitHub when no signed rules exist', async () => {
  const dir = usesAcme();
  const seen = [];
  const r = await cli(['watch', '--root', dir], fakeFetch(upstreamRoutes(), seen));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /acme-sdk: 1\.4\.1 -> 2\.1\.0 in package\.json: 3 unsigned draft rules from api\.md at github\.com\/acme\/acme-node@aaaaaaaaaaaa and github\.com\/acme\/acme-node@v2\.1\.0, 0 need review/);
  assert.ok(seen.includes(`${RAW}/acme/acme-node/${HEAD}/src/resources/missing/api.md`), 'a linked file that is missing is skipped');
  const [entry] = JSON.parse(readFileSync(join(dir, '.apimigrate/watch/plan.json'), 'utf8')).upgrades;
  assert.deepEqual([entry.source, entry.signed, entry.rules, entry.ruleCount], ['draft', false, '.apimigrate/watch/acme-sdk-1-to-2.draft.json', 3]);
  assert.deepEqual([entry.upstream.from.ref, entry.upstream.to.ref, entry.upstream.to.files], [HEAD, 'v2.1.0', 2]);
  const drafted = JSON.parse(readFileSync(join(dir, entry.rules), 'utf8'));
  assert.equal(drafted.draft, true);
  assert.equal(drafted.provider, 'acme');
  assert.deepEqual(drafted.rules.map((x) => [x.kind, x.match, x.transform]), [
    ['rename-import', { module: 'acme-sdk' }, { to: '@acme/sdk' }],
    ['rename-namespace', { path: 'jobsPreview' }, { to: 'jobs' }],
    ['rename-dependency', { dependency: 'acme-sdk' }, { to: '@acme/sdk', version: '^2.1.0' }],
  ]);
  const applied = await cli(['apply', '--root', dir, '--rules', join(dir, entry.rules), '--allow-unsigned']);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(readFileSync(join(dir, 'src/app.ts'), 'utf8'), "import Acme from '@acme/sdk';\nconst client = new Acme();\nexport const jobs = () => client.jobs.list();\n");
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies['@acme/sdk'], '^2.1.0');
});

test('a drafted upgrade keeps the package name unless the new name is published, and says why a draft is missing', async () => {
  const dir = usesAcme();
  await cli(['watch', '--root', dir], fakeFetch(upstreamRoutes({ renamedOnNpm: false })));
  const [entry] = JSON.parse(readFileSync(join(dir, '.apimigrate/watch/plan.json'), 'utf8')).upgrades;
  const drafted = JSON.parse(readFileSync(join(dir, entry.rules), 'utf8'));
  assert.deepEqual(drafted.rules.map((x) => x.kind), ['rename-namespace', 'rename-dependency']);
  assert.deepEqual(drafted.rules[1].transform, { version: '^2.1.0' });

  const routes = upstreamRoutes();
  const without = (drop) => fakeFetch(Object.fromEntries(Object.entries(routes).filter(([u]) => !drop(u))));
  const reason = async (fetchImpl) => (await cli(['watch', '--root', usesAcme(), '--dry-run'], fetchImpl)).out;
  assert.match(await reason(without((u) => u.startsWith(`${RAW}/acme/acme-node/v2.1.0/`))), /no draft: github\.com\/acme\/acme-node has no api\.md for acme-sdk@2\.1\.0 at v2\.1\.0, 2\.1\.0, acme-sdk-v2\.1\.0, acme-sdk@2\.1\.0/);
  routes[`${R}/acme-sdk/1.4.1`] = { name: 'acme-sdk', version: '1.4.1', repository: 'https://gitlab.com/acme/acme-node' };
  assert.match(await reason(fakeFetch(routes)), /no draft: acme-sdk@1\.4\.1 names no GitHub repository/);
});

test('GitHub repositories and release refs are read from npm manifests', () => {
  const cases = [
    ['git+https://github.com/muxinc/mux-node-sdk.git', 'muxinc/mux-node-sdk'], ['https://github.com/openai/openai-node', 'openai/openai-node'],
    ['git@github.com:o/r.git', 'o/r'], ['git+ssh://git@github.com/o/r.git', 'o/r'], ['github:o/r', 'o/r'], ['o/r', 'o/r'],
    ['https://github.com/o/r/tree/main/packages/x', 'o/r'], ['https://gitlab.com/o/r', null], ['github:o/..', null], [42, null],
  ];
  for (const [url, want] of cases) {
    const got = githubRepo({ repository: { url } });
    assert.equal(got ? `${got.owner}/${got.repo}` : null, want, String(url));
  }
  assert.deepEqual(githubRepo({ repository: { url: 'github:o/r', directory: './packages/sdk/' } }), { owner: 'o', repo: 'r', dir: 'packages/sdk' });
  assert.equal(githubRepo({ repository: { url: 'github:o/r', directory: 'packages/../..' } }), null);
  assert.deepEqual(releaseRefs({ gitHead: HEAD }, '@scope/tool', '2.0.0'), [HEAD, 'v2.0.0', '2.0.0', 'tool-v2.0.0', 'tool@2.0.0']);
  assert.deepEqual(releaseRefs({ gitHead: 'not-a-sha' }, 'x', '1.0.0')[0], 'v1.0.0');
});

test('fetchText follows redirects only on the same https host and only when asked', async () => {
  const hop = (location) => async (url) => (url.endsWith('/old')
    ? { ok: false, status: 301, headers: { get: (h) => (h === 'location' ? location : null) }, text: async () => '' }
    : { ok: true, status: 200, headers: { get: () => null }, text: async () => `at ${url}` });
  assert.equal(await fetchText('https://raw.example/old', { fetchImpl: hop('/new'), sameHostRedirects: 1 }), 'at https://raw.example/new');
  await assert.rejects(fetchText('https://raw.example/old', { fetchImpl: hop('https://evil.example/new'), sameHostRedirects: 1 }), /to another host/);
  await assert.rejects(fetchText('https://raw.example/old', { fetchImpl: hop('/old'), sameHostRedirects: 2 }), /redirects more than 2 times/);
  await assert.rejects(fetchText('https://raw.example/old', { fetchImpl: hop('/new') }), /HTTP 301/);
});

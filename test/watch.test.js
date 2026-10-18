import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../src/cli.js';
import { withDefaults } from '../src/config.js';
import { findUpgrades, lineOf, rangeLine } from '../src/registry.js';
import { generateKeys, signRuleSet } from '../src/signing.js';
import { parseSources, signedRulesFor } from '../src/sources.js';
import { RAW, githubRepo, releaseRefs } from '../src/upstream.js';
import { openWatchPullRequests } from '../src/watchpr.js';
import { watchBranch, watchTitle } from '../src/prbody.js';
import { fetchText } from '../src/net.js';
import { versionLine } from '../src/commands/index.js';

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

// A consumer repository with a bare remote, and a stand-in for gh that records what it was asked to do.
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim().replace(/\r\n/g, '\n');
};
function consumer(extra = '') {
  const dir = repoWith({
    'package.json': JSON.stringify({ dependencies: { 'acme-sdk': '^1.4.0' } }),
    'src/app.ts': "import Acme from 'acme-sdk';\nconst client = new Acme();\nexport const jobs = () => client.jobsPreview.list();\nexport const pay = () => client.charges.create();\n",
    '.apimigrate.yml': `sources:\n- "acme-sdk ${DOMAIN}"\n${extra}`,
  });
  const remote = mkdtempSync(join(tmpdir(), 'remote-'));
  git(remote, 'init', '-q', '--bare');
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'base');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  const calls = [];
  const watchAndOpen = async (routes, gh = (args) => calls.push(args)) => {
    const w = await cli(['watch', '--root', dir], fakeFetch(routes));
    assert.equal(w.code, 0, w.err);
    const log = [];
    // The packages here are not on npm, so nothing is installed. test/install.test.js covers installs.
    const code = await openWatchPullRequests({ root: dir, planPath: join(dir, '.apimigrate/watch/plan.json'), install: 'none', gh, out: (x) => log.push(x), err: (x) => log.push(x) });
    return { code, log: log.join('\n') };
  };
  return { dir, remote, calls, watchAndOpen };
}

test('watch mode opens one draft pull request per upgrade, marks drafts unsigned, and skips branches that exist', async () => {
  const { dir, remote, calls, watchAndOpen } = consumer();
  const drafted = await watchAndOpen(upstreamRoutes());
  assert.equal(drafted.code, 0, drafted.log);
  assert.match(drafted.log, /acme-sdk 1\.4\.1 -> 2\.1\.0: opened a draft pull request from apimigrate\/acme-sdk-1-to-2-unsigned, marked unsigned/);
  const signedRoutes = { ...upstreamRoutes(), ...providerRoutes().routes };
  const signed = await watchAndOpen(signedRoutes);
  assert.equal(signed.code, 0, signed.log);
  assert.match(signed.log, /opened a draft pull request from apimigrate\/acme-sdk-1-to-2$/m);
  const again = await watchAndOpen(signedRoutes);
  assert.match(again.log, /skipped, apimigrate\/acme-sdk-1-to-2 already exists/);

  assert.equal(calls.length, 2, 'a branch that exists is not opened again');
  const [unsignedPr, signedPr] = calls;
  assert.deepEqual(unsignedPr.slice(0, 9), ['pr', 'create', '--draft', '--base', 'main', '--head', 'apimigrate/acme-sdk-1-to-2-unsigned', '--title', '[unsigned draft] API migration: acme-sdk 1.4.1 to 2.1.0']);
  assert.deepEqual(signedPr.slice(6, 9), ['apimigrate/acme-sdk-1-to-2', '--title', 'API migration: acme-sdk 1.4.1 to 2.1.0']);
  const unsignedBody = readFileSync(unsignedPr[10], 'utf8');
  assert.match(unsignedBody, /^> \[!WARNING\]\n> \*\*Unsigned\.\*\* No signed rules were found for `acme-sdk`/);
  assert.match(unsignedBody, /api\.md files of the two releases, `github\.com\/acme\/acme-node@a{40}` and `github\.com\/acme\/acme-node@v2\.1\.0`/);
  assert.match(unsignedBody, /> `no usable signed rules from acme\.example: could not fetch/);
  assert.match(unsignedBody, /\| `namespace-jobsPreview` \| `rename-namespace` \| `likely` \|/);
  assert.match(unsignedBody, /\| Signed \| no \|/);
  assert.doesNotMatch(unsignedBody, /--well-known/);
  const signedBody = readFileSync(signedPr[10], 'utf8');
  assert.match(signedBody, /signed by `acme\.example` with key `k1`/);
  assert.match(signedBody, /\| Signed \| yes, key `k1` \|/);

  const show = (ref, file) => git(remote, 'show', `${ref}:${file}`);
  assert.equal(show('apimigrate/acme-sdk-1-to-2-unsigned', 'src/app.ts'), "import Acme from '@acme/sdk';\nconst client = new Acme();\nexport const jobs = () => client.jobs.list();\nexport const pay = () => client.charges.create();");
  assert.equal(show('apimigrate/acme-sdk-1-to-2', 'src/app.ts'), "import Acme from 'acme-sdk';\nconst client = new Acme();\nexport const jobs = () => client.jobsPreview.list();\nexport const pay = () => client.payments.create();");
  assert.equal(git(remote, 'diff', '--name-only', 'main', 'apimigrate/acme-sdk-1-to-2-unsigned'), 'package.json\nsrc/app.ts', 'only the changed files are committed');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('watch mode skips unsigned drafts when pins are set, and deletes the branch when gh fails', async () => {
  const pinned = consumer(`pins:\n- ${'0'.repeat(64)}\n`);
  const skipped = await pinned.watchAndOpen({ ...upstreamRoutes(), ...providerRoutes().routes });
  assert.equal(skipped.code, 0, skipped.log);
  assert.match(skipped.log, /skipped, the draft is unsigned and \.apimigrate\.yml sets pins/);
  assert.equal(pinned.calls.length, 0);

  const failing = consumer();
  const r = await failing.watchAndOpen(upstreamRoutes(), () => { throw new Error('gh pr create failed with exit code 1'); });
  assert.equal(r.code, 1);
  assert.match(r.log, /gh pr create failed/);
  assert.equal(spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/apimigrate/acme-sdk-1-to-2-unsigned'], { cwd: failing.dir }).status, 2);
  assert.equal(git(failing.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('watch branches depend only on the package, the lines and whether the rules are signed', () => {
  const e = { package: '@mux/mux-node', line: '14', from: '14.1.1', to: '15.5.0', source: 'draft' };
  assert.equal(watchBranch(e), 'apimigrate/mux-mux-node-14-to-15-unsigned');
  assert.equal(watchBranch({ ...e, to: '15.6.0', source: 'signed' }), 'apimigrate/mux-mux-node-14-to-15');
  assert.equal(watchBranch({ ...e, line: '0.44', to: '0.45.1' }), 'apimigrate/mux-mux-node-0.44-to-0.45-unsigned');
  assert.equal(watchTitle(e), '[unsigned draft] API migration: @mux/mux-node 14.1.1 to 15.5.0');
});

test('rule file versions name a line, and 0.x names none', () => {
  const cases = [['1.x', '1'], ['14', '14'], ['14.x.x', '14'], ['v2.3.0', '2'], ['^2.3.0', '2'], ['~15.1', '15'], ['3.0.0-beta.1', '3'], ['0.44.x', '0.44'], ['0.44', '0.44'],
    ['0.x', null], ['0', null], ['latest', null], ['>=1 <3', null], ['1.x || 2.x', null], [2, null]];
  for (const [v, line] of cases) assert.equal(versionLine(v), line, String(v));
});

test('index lists signed rule files so that watch finds and verifies them', async () => {
  const keyDir = mkdtempSync(join(tmpdir(), 'keys-'));
  assert.equal((await cli(['keygen', '--out', keyDir])).code, 0);
  const keys = join(keyDir, 'apimigrate-keys.json');
  const tool = { ...ruleFor('@scope/tool'), id: 'tool-0.8-to-0.9', from: '0.8.x', to: '0.9.x' };
  const dir = repoWith({ 'acme-sdk-1-to-2.json': JSON.stringify(ruleFor()), 'scope-tool-0.8-to-0.9.json': JSON.stringify(tool), 'README.md': 'not a rule file' });
  for (const f of ['acme-sdk-1-to-2.json', 'scope-tool-0.8-to-0.9.json']) assert.equal((await cli(['sign', join(dir, f), '--key', join(keyDir, 'apimigrate-private.pem')])).code, 0);

  const printed = await cli(['index', dir, '--base-url', `https://${DOMAIN}/rules`, '--keys', keys]);
  assert.equal(printed.code, 0, printed.err);
  assert.deepEqual(JSON.parse(printed.out), { rules: [
    { package: '@scope/tool', from: '0.8', to: '0.9', url: `https://${DOMAIN}/rules/scope-tool-0.8-to-0.9.json` },
    { package: 'acme-sdk', from: '1', to: '2', url: `https://${DOMAIN}/rules/acme-sdk-1-to-2.json` },
  ] });
  const out = join(dir, 'apimigrate-rules.json');
  for (let i = 0; i < 2; i++) {
    const written = await cli(['index', dir, '--base-url', `https://${DOMAIN}/rules/`, '--keys', keys, '--out', out]);
    assert.equal(written.code, 0, written.err);
    assert.equal(readFileSync(out, 'utf8'), printed.out + '\n', 'the same files give the same index, and the index is not read as a rule file');
  }
  assert.match((await cli(['index', '--help'])).out, /^usage: apimigrate index <rules dir> --base-url/);

  const signed = Object.fromEntries(JSON.parse(printed.out).rules.map((r) => [r.url, readFileSync(join(dir, r.url.split('/').at(-1)), 'utf8')]));
  const routes = { ...registryRoutes, ...signed, [`https://${DOMAIN}/.well-known/apimigrate-rules.json`]: readFileSync(out, 'utf8'), [`https://${DOMAIN}/.well-known/apimigrate-keys.json`]: readFileSync(keys, 'utf8') };
  const consumer = repoWith({
    'package.json': JSON.stringify({ dependencies: { 'acme-sdk': '^1.4.0', '@scope/tool': '^0.8.0' } }),
    '.apimigrate.yml': `sources:\n- "acme-sdk ${DOMAIN}"\n- "@scope/tool ${DOMAIN}"\n`,
  });
  const w = await cli(['watch', '--root', consumer], fakeFetch(routes));
  assert.equal(w.code, 0, w.err);
  assert.match(w.out, /@scope\/tool: 0\.8\.3 -> 0\.9\.0 in package\.json: signed rules from acme\.example/);
  assert.match(w.out, /acme-sdk: 1\.4\.1 -> 2\.1\.0 in package\.json: signed rules from acme\.example/);
  const plan = JSON.parse(readFileSync(join(consumer, '.apimigrate/watch/plan.json'), 'utf8'));
  assert.deepEqual(plan.upgrades.map((u) => [u.package, u.source, u.url, u.keyId, u.hash]), Object.entries(signed).map(([url, text]) => [JSON.parse(text).package, 'signed', url, 'k1', JSON.parse(text).signature.hash]));
  for (const u of plan.upgrades) {
    const check = await cli(['check', join(consumer, u.rules), '--keys', join(consumer, u.keys)]);
    assert.equal(check.code, 0, check.err);
  }
});

test('index names every refused rule file and its reason, and writes nothing', async () => {
  const signer = generateKeys();
  const keys = join(repoWith({ 'apimigrate-keys.json': JSON.stringify({ keys: [{ keyId: 'k1', publicKey: signer.publicPem }] }) }), 'apimigrate-keys.json');
  const signed = (extra = {}, by = signer) => JSON.stringify(signRuleSet({ ...ruleFor(), ...extra }, by.privatePem, 'k1'));
  const { package: _, ...noPackage } = ruleFor();
  const dir = repoWith({
    'a-good.json': signed(),
    'b-same-lines.json': signed({ id: 'again', from: '1.2.0', to: '^2.0.0' }),
    'draft.json': JSON.stringify({ ...ruleFor(), draft: true }),
    'unsigned.json': JSON.stringify(ruleFor()),
    'expired.json': signed({ sunset: '2020-01-01' }),
    'other-key.json': signed({}, generateKeys()),
    'zero.json': signed({ from: '0.x', to: '1.x' }),
    'backwards.json': signed({ from: '2.x', to: '2.5' }),
    'any.json': JSON.stringify(signRuleSet({ ...noPackage, scope: 'any' }, signer.privatePem, 'k1')),
    'invalid.json': JSON.stringify({ schema: 'apimigrate/1' }),
    'broken.json': '{ nope',
  });
  const out = join(dir, 'apimigrate-rules.json');
  const index = (...extra) => cli(['index', dir, '--base-url', `https://${DOMAIN}/rules`, '--keys', keys, ...extra]);
  const r = await index('--out', out);
  assert.equal(r.code, 3, 'a trust refusal exits 3');
  assert.equal(existsSync(out), false);
  const [head, ...lines] = r.err.split('\n');
  assert.equal(head, 'error: refusing to build the index, nothing was written:');
  const reasons = Object.fromEntries(lines.map((l) => l.trim().split(/: (.*)/s, 2)));
  const want = {
    'any.json': /^has no package, so watch cannot match it$/,
    'b-same-lines.json': /^acme-sdk 1 to 2 is already in a-good\.json$/,
    'backwards.json': /^to line 2 is not after from line 2$/,
    'broken.json': /^cannot read it as JSON: /,
    'draft.json': /^file is marked draft$/,
    'expired.json': /^has passed its sunset date 2020-01-01$/,
    'invalid.json': /^not a valid rule file: missing provider, missing id, /,
    'other-key.json': /^bad signature$/,
    'unsigned.json': /^unsigned$/,
    'zero.json': /^from "0\.x" names no version line, such as "2\.x", or "0\.44\.x" below 1\.0$/,
  };
  assert.deepEqual(Object.keys(reasons), Object.keys(want));
  for (const [file, reason] of Object.entries(want)) assert.match(reasons[file], reason, file);

  const dup = repoWith({ 'a.json': signed(), 'b.json': signed({ id: 'b' }) });
  const d = await cli(['index', dup, '--base-url', `https://${DOMAIN}/rules`, '--keys', keys]);
  assert.equal(d.code, 2, 'refusals that are not about trust exit 2');
  assert.match(d.err, /^ {2}b\.json: acme-sdk 1 to 2 is already in a\.json$/m);
  assert.equal(d.out, '');

  const usage = async (args, pattern) => {
    const u = await cli(['index', ...args]);
    assert.equal(u.code, 2, args.join(' '));
    assert.match(u.err, pattern);
  };
  await usage([dup, '--base-url', `https://${DOMAIN}/rules`], /index needs --base-url and --keys/);
  await usage([dup, '--keys', keys], /index needs --base-url and --keys/);
  for (const url of [`http://${DOMAIN}/rules`, 'acme.example/rules', `https://${DOMAIN}/rules?v=1`, `https://user@${DOMAIN}/rules`]) await usage([dup, '--base-url', url, '--keys', keys], /--base-url must be an https URL/);
  await usage([dup, '--base-url', `https://${DOMAIN}/rules`, '--keys', join(dirname(keys), 'apimigrate-public.pem')], /--keys must be the key set JSON/);
  await usage([repoWith({ 'notes.txt': 'x' }), '--base-url', `https://${DOMAIN}/rules`, '--keys', keys], /has no \.json rule files/);
  await usage([join(dup, 'missing'), '--base-url', `https://${DOMAIN}/rules`, '--keys', keys], /cannot read .*missing/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diffSurfaces, draftFromSurfaces, readApiSurface } from '../src/apimd.js';
import { main } from '../src/cli.js';
import { signingBlockers, validateRuleSet } from '../src/rule.js';

const method = (verb, path, call, file, args = '', ret = 'Thing') => `- <code title="${verb} ${path}">client.${call.split('.').slice(0, -1).join('.')}.<a href="./src/${file}">${call.split('.').at(-1)}</a>(${args}) -> ${ret}</code>`;
const type = (name, file) => `- <code><a href="./src/${file}">${name}</a></code>`;

function checkout(files) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); }
  return dir;
}

// A small SDK in the Stainless api.md layout: a root api.md that links to one per resource.
const sdk = (name, version, resources) => checkout({
  'package.json': JSON.stringify({ name, version }),
  'api.md': ['# Shared', '', ...resources.map((r) => `# [${r.title}](src/resources/${r.dir}/api.md)`)].join('\n') + '\n',
  ...Object.fromEntries(resources.map((r) => [`src/resources/${r.dir}/api.md`, [`# ${r.title}`, '', 'Types:', '', ...r.types, '', 'Methods:', '', ...r.methods].join('\n') + '\n'])),
});

const old = () => sdk('acme-sdk', '1.4.0', [
  { title: 'Jobs', dir: 'jobs-preview', types: [type('Job', 'resources/jobs-preview/jobs.ts')], methods: [
    method('get', '/jobs', 'jobsPreview.list', 'resources/jobs-preview/jobs.ts'),
    method('post', '/jobs', 'jobsPreview.create', 'resources/jobs-preview/jobs.ts', '{ ...params }'),
    method('get', '/jobs/{ID}/result', 'jobsPreview.results.retrieve', 'resources/jobs-preview/results.ts', 'id'),
    method('get', '/jobs/{job_id}/runs/{run_id}', 'jobsPreview.runs.get', 'resources/jobs-preview/runs.ts', 'jobId, runId, { ...params }'),
  ] },
  { title: 'Members', dir: 'members', types: [], methods: [method('get', '/members/{member_id}', 'members.get', 'resources/members.ts', 'memberId, { ...params }')] },
  { title: 'Data', dir: 'data', types: [type('FilterValue', 'resources/data/filters.ts'), type('Gone', 'resources/data/gone.ts')], methods: [
    method('get', '/data/filters/{ID}', 'data.filters.listValues', 'resources/data/filters.ts', 'id, { ...params }'),
    method('get', '/data/dimensions/{ID}', 'data.dimensions.listValues', 'resources/data/dimensions.ts', 'id, { ...params }'),
    method('delete', '/assets/{ID}', 'video.assets.del', 'resources/data/assets.ts', 'id'),
    method('patch', '/assets/{ID}', 'video.assets.update', 'resources/data/assets.ts', 'id, { ...params }'),
  ] },
]);

const next = () => sdk('@acme/sdk', '2.0.0', [
  { title: 'Jobs', dir: 'jobs', types: [type('Job', 'resources/jobs/jobs.ts')], methods: [
    method('get', '/jobs', 'jobs.list', 'resources/jobs/jobs.ts'),
    method('post', '/jobs', 'jobs.create', 'resources/jobs/jobs.ts', '{ ...params }'),
    method('get', '/jobs/{ID}/result', 'jobs.results.retrieve', 'resources/jobs/results.ts', 'id'),
    method('get', '/jobs/{job_id}/runs/{run_id}', 'jobs.runs.get', 'resources/jobs/runs.ts', 'runID, { ...params }'),
  ] },
  { title: 'Members', dir: 'members', types: [], methods: [method('get', '/members/{member_id}', 'members.get', 'resources/members.ts', 'memberID, { ...params }')] },
  { title: 'Data', dir: 'data', types: [type('FilterValue', 'resources/data/filters.ts')], methods: [
    method('get', '/data/dimensions/{ID}', 'data.dimensions.listValues', 'resources/data/dimensions.ts', 'id, { ...params }'),
    method('delete', '/assets/{ID}', 'video.assets.delete', 'resources/data/assets.ts', 'id'),
    method('patch', '/assets/{ID}', 'video.assets.update', 'resources/data/assets.ts', 'id, body'),
    method('get', '/new', 'video.fresh', 'resources/data/assets.ts', '', 'Fresh'),
  ] },
]);

test('api.md surfaces are read across linked files with their endpoints and type files', () => {
  const s = readApiSurface(old());
  assert.equal(s.name, 'acme-sdk');
  assert.equal(s.version, '1.4.0');
  assert.equal(s.files.length, 4);
  assert.deepEqual(s.methods.get('GET /jobs/{ID}/result'), [{ call: 'jobsPreview.results.retrieve', file: 'src/resources/jobs-preview/results.ts', args: 'id', returns: 'Thing', section: ['Jobs'] }]);
  assert.deepEqual([...s.sections], ['Shared', 'Jobs', 'Members', 'Data']);
  assert.deepEqual([...s.types.get('Job')], ['src/resources/jobs-preview/jobs.ts']);
  assert.throws(() => readApiSurface(mkdtempSync(join(tmpdir(), 'empty-'))), /has no api\.md/);
});

test('drafts from two SDK versions: moved modules, package rename, namespace, renamed and removed methods, dependency', () => {
  const a = readApiSurface(old());
  const b = readApiSurface(next());
  const diff = diffSurfaces(a, b);
  assert.deepEqual(diff.moves, [{ from: 'resources/jobs-preview', to: 'resources/jobs' }]);
  assert.deepEqual(diff.removedTypes, ['Gone']);
  assert.deepEqual(diff.added.map((x) => x.call), ['video.fresh']);
  assert.deepEqual(diff.argsChanged.map((c) => c.call), ['jobs.runs.get', 'video.assets.update'], 'renaming a placeholder such as memberId to memberID is not a change');
  const { ruleSet, report } = draftFromSurfaces(diff, { provider: 'acme', from: a.version, to: b.version, oldName: a.name, newName: b.name, newVersion: b.version, oldMethods: [...a.methods.values()].flat().map((m) => m.call) });
  const summary = ruleSet.rules.map((r) => [r.kind, r.confidence, r.match, r.transform ?? null]);
  assert.deepEqual(summary, [
    ['rename-import', 'likely', { module: 'acme-sdk/resources/jobs-preview' }, { to: '@acme/sdk/resources/jobs' }],
    ['rename-import', 'likely', { module: 'acme-sdk' }, { to: '@acme/sdk' }],
    ['rename-namespace', 'likely', { path: 'jobsPreview' }, { to: 'jobs' }],
    ['rename-method', 'likely', { call: 'video.assets.del' }, { to: 'video.assets.delete' }],
    ['manual', 'needs-review', { call: 'data.filters.listValues' }, null],
    ['positional-to-named', 'likely', { call: 'jobs.runs.get', positional: 2 }, { names: ['job_id'] }],
    ['manual', 'needs-review', { call: 'video.assets.update' }, null],
    ['rename-dependency', 'likely', { dependency: 'acme-sdk' }, { to: '@acme/sdk', version: '^2.0.0' }],
  ]);
  assert.match(ruleSet.rules[4].fallback.prompt, /A likely replacement is client\.data\.dimensions\.listValues\./);
  assert.match(ruleSet.rules[6].fallback.prompt, /changed from \(id, \{ \.\.\.params \}\) to \(id, body\)/);
  assert.equal(ruleSet.draft, true);
  assert.ok(signingBlockers(ruleSet).length > 0, 'a draft cannot be signed');
  assert.deepEqual(validateRuleSet(ruleSet), []);
  assert.deepEqual(report.methodsAdded, ['video.fresh']);
});

test('draft accepts two SDK folders on the command line and refuses a mix', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'draft-')), 'rules.json');
  const io = { lines: [], out(s) { this.lines.push(s); }, err(s) { this.lines.push(s); } };
  assert.equal(await main(['draft', old(), next(), '--provider', 'acme', '--out', out], io), 0, io.lines.join('\n'));
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(written.package, 'acme-sdk');
  assert.equal(written.id, 'acme-sdk-1.4.0-to-2.0.0');
  assert.match(io.lines[0], /8 draft rules written/);
  const spec = join(dirname(out), 'spec.json');
  writeFileSync(spec, '{}');
  assert.equal(await main(['draft', old(), spec], io), 2);
  assert.equal(await main(['draft', old(), next(), '--naming', 'identity'], io), 2);
});

test('a module is only moved when everything defined under it moved the same way', () => {
  const surface = (types) => ({ methods: new Map(), types: new Map(Object.entries(types).map(([k, v]) => [k, new Set([v])])) });
  const partial = diffSurfaces(
    surface({ Route: 'src/resources/radar/bgp.ts', Hijack: 'src/resources/radar/bgp.ts', Leak: 'src/resources/radar/bgp/leaks.ts' }),
    surface({ Route: 'src/resources/radar/bgp/routes.ts', Hijack: 'src/resources/radar/bgp.ts', Leak: 'src/resources/radar/bgp/leaks.ts' }),
  );
  assert.deepEqual(partial.moves, []);
  assert.deepEqual(partial.partialMoves, [{ from: 'resources/radar/bgp', to: 'resources/radar/bgp/routes', unmoved: 2, moved: 1 }]);
  const whole = diffSurfaces(
    surface({ A: 'src/resources/jobs-preview/a.ts', C: 'src/resources/jobs-preview/b/c.ts' }),
    surface({ A: 'src/resources/jobs/a.ts', C: 'src/resources/jobs/b/c.ts' }),
  );
  assert.deepEqual(whole.moves, [{ from: 'resources/jobs-preview', to: 'resources/jobs' }]);
  assert.deepEqual(whole.partialMoves, []);
});

test('a renamed resource gets a rename-namespace rule for its type namespace when the api.md headings name it', () => {
  const m = (verb, path, call) => method(verb, path, call, 'resources/x.ts', 'id');
  const release = (version, { robots, beta, plans, archive, other }) => checkout({
    'package.json': JSON.stringify({ name: 'acme-sdk', version }),
    'api.md': [
      '# Shared', '', `# [${robots[0]}](src/resources/${robots[1]}/api.md)`, '',
      '# Beta', '', `## ${beta[0]}`, '', m('get', '/plans/{id}', `beta.${beta[1]}.fetch`), m('post', '/plans/{id}/versions', `beta.${beta[1]}.createVersion`), '',
      '# Plans', '', '## ExternalPlanID', '', m('put', '/p/{id}', `plans.${plans}.update`), m('get', '/p/{id}', `plans.${plans}.fetch`), '',
      `# ${archive}`, '', m('get', '/legacy/a', `${archive.toLowerCase()}.a`), m('get', '/legacy/b', `${archive.toLowerCase()}.b`), '',
      ...(archive === 'Legacy' ? [] : ['# Legacy', '', 'Types:', '', type('Kept', 'resources/x.ts'), '']),
      `# ${other}`, '', m('get', '/misc/a', `${other.toLowerCase()}.a.run`), m('get', '/misc/b', `${other.toLowerCase()}.b.run`), '',
    ].join('\n'),
    [`src/resources/${robots[1]}/api.md`]: [`# ${robots[0]}`, '', '## Jobs', '', m('get', '/robots/jobs', `${robots[2]}.jobs.list`), '', '### AskQuestions', '', m('post', '/robots/jobs/ask', `${robots[2]}.jobs.askQuestions.create`)].join('\n'),
  });
  const a = readApiSurface(release('1.0.0', { robots: ['RobotsPreview', 'robots-preview', 'robotsPreview'], beta: ['ExternalPlanID', 'externalPlanId'], plans: 'externalPlanId', archive: 'Legacy', other: 'Misc' }));
  const b = readApiSurface(release('2.0.0', { robots: ['Robots', 'robots', 'robots'], beta: ['ExternalPlans', 'externalPlans'], plans: 'externalPlanID', archive: 'Archive', other: 'Other' }));
  assert.deepEqual(a.methods.get('POST /robots/jobs/ask')[0].section, ['RobotsPreview', 'Jobs', 'AskQuestions']);
  const { ruleSet } = draftFromSurfaces(diffSurfaces(a, b), { provider: 'acme', from: a.version, to: b.version, oldName: a.name, newName: b.name, newVersion: b.version, oldMethods: [...a.methods.values()].flat().map((x) => x.call) });
  // The type namespace comes from the headings, not from capitalising the path, which would give ExternalPlanId. A case-only
  // change of the path keeps ## ExternalPlanID, Legacy is still a section in 2.0.0, and # Misc does not head misc.a or misc.b.
  assert.deepEqual(ruleSet.rules.filter((r) => r.kind === 'rename-namespace').map((r) => [r.id, r.confidence, r.match.path, r.transform.to]), [
    ['namespace-beta.externalPlanId', 'likely', 'beta.externalPlanId', 'beta.externalPlans'],
    ['type-Beta.ExternalPlanID', 'likely', 'Beta.ExternalPlanID', 'Beta.ExternalPlans'],
    ['namespace-plans.externalPlanId', 'likely', 'plans.externalPlanId', 'plans.externalPlanID'],
    ['namespace-legacy', 'likely', 'legacy', 'archive'],
    ['namespace-misc', 'likely', 'misc', 'other'],
    ['namespace-robotsPreview', 'likely', 'robotsPreview', 'robots'],
    ['type-RobotsPreview', 'likely', 'RobotsPreview', 'Robots'],
  ]);
  assert.equal(ruleSet.rules.find((r) => r.id === 'type-RobotsPreview').evidence, 'api.md lists every method under robotsPreview in section RobotsPreview in 1.0.0, and every method under robots in section Robots in 2.0.0, which has no section RobotsPreview');
  assert.deepEqual(validateRuleSet(ruleSet), []);
});

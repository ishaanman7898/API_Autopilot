import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRuleSet } from '../src/engine.js';
import { buildEvidence, replay } from '../src/evidence.js';
import { runGate } from '../src/gate.js';
import { validateRuleSet } from '../src/rule.js';
import { cases, ruleSet } from './fixtures/match-cases.js';

for (const c of cases) {
  test(`match: ${c.name}`, () => {
    const rs = ruleSet(c.rules, c.extra);
    assert.deepEqual(validateRuleSet(rs), []);
    const r = applyRuleSet(rs, c.files, c.configs);
    for (const [file, text] of Object.entries(c.expect)) assert.equal(r.files[file], text, file);
    for (const file of c.untouched ?? []) assert.equal(r.files[file], c.files[file], `${file} must be untouched`);
    const got = r.unresolved.map((u) => [u.file, u.line, u.reason]);
    assert.equal(got.length, c.unresolved.length, JSON.stringify(got));
    for (const [file, line, reason] of c.unresolved) {
      assert.ok(got.some((g) => g[0] === file && g[1] === line && g[2].includes(reason)), `missing unresolved ${file}:${line} ${reason}; got ${JSON.stringify(got)}`);
    }
    assert.deepEqual(r.skipped.map((s) => s.file), c.skipped ?? []);
  });
}

test('rules are applied in order and later rules see earlier output', () => {
  const r = applyRuleSet(ruleSet(cases[0].rules), cases[0].files);
  assert.equal(r.changes.length, 2);
  assert.ok(r.changes.every((c) => c.proven));
});

test('rename-option rules need a call path, an argument index, a key and a different new key, and only they and manual rules take new or default', () => {
  const option = (id, match, to = 'b') => ({ id, kind: 'rename-option', match: { key: 'a', ...match }, transform: { to } });
  const errors = validateRuleSet(ruleSet([
    option('ok', { call: 'new default', arg: 0 }),
    option('no-arg', { call: 'new Client' }),
    option('negative', { call: 'create', arg: -1 }),
    option('same', { call: 'create', arg: 0 }, 'a'),
    option('bad-call', { call: 'new Client()', arg: 0 }),
    { id: 'method', kind: 'rename-method', match: { call: 'new Client' }, transform: { to: 'Client2' } },
    { id: 'param', kind: 'rename-param', match: { call: 'default', param: 'a' }, transform: { to: 'b' } },
    { id: 'manual', kind: 'manual', match: { call: 'new Client' }, fallback: { prompt: 'p' } },
  ]));
  assert.deepEqual(errors.map((e) => e.slice(0, e.indexOf(':'))), ['rules[1]', 'rules[2]', 'rules[3]', 'rules[4]', 'rules[5]', 'rules[6]']);
  assert.match(errors[0], /needs match\.call, match\.arg as an argument index from 0, match\.key and a different transform\.to/);
  assert.match(errors[4], /only rename-option and manual rules can match a new or default call path/);
});

test('a rename-option run passes the gate and replays from its evidence, and a changed base tree is drift', () => {
  const c = cases.find((x) => x.name.startsWith('rename-option renames a client option'));
  const rs = ruleSet(c.rules);
  const deterministic = applyRuleSet(rs, c.files);
  const gate = runGate({ base: c.files, head: deterministic.files });
  assert.equal(gate.ok, true, JSON.stringify(gate.findings));
  const evidence = buildEvidence({ ruleSet: rs, before: c.files, deterministic, gate, tool: { name: 'apimigrate', version: 'test' } });
  assert.deepEqual(evidence.callSites.map((x) => [x.file, x.line, x.ruleId]), [
    ['a.ts', 4, 'key'], ['a.ts', 4, 'url'], ['a.ts', 5, 'url-named'], ['a.ts', 6, 'url-named'], ['a.ts', 7, 'url'], ['a.ts', 10, 'url'], ['b.js', 3, 'url'], ['b.js', 3, 'url-named'],
  ]);
  assert.equal(replay(rs, c.files, evidence).ok, true);
  const drifted = replay(rs, { ...c.files, 'b.js': c.files['b.js'].replace("baseUrl: 'b'", "baseUrl: 'B'") }, evidence);
  assert.deepEqual([drifted.ok, drifted.drift], [false, ['b.js']]);
});

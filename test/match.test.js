import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRuleSet } from '../src/engine.js';
import { validateRuleSet } from '../src/rule.js';
import { cases, ruleSet } from './fixtures/match-cases.js';

for (const c of cases) {
  test(`match: ${c.name}`, () => {
    const rs = ruleSet(c.rules);
    assert.deepEqual(validateRuleSet(rs), []);
    const r = applyRuleSet(rs, c.files);
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

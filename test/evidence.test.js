import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRuleSet } from '../src/engine.js';
import { buildEvidence, checkHead, replay } from '../src/evidence.js';
import { runGate } from '../src/gate.js';
import { generateKeys, signRuleSet } from '../src/signing.js';
import { denormalize, normalize, readTree, writeChanged } from '../src/tree.js';
import { cases, ruleSet } from './fixtures/match-cases.js';

const rules = cases[0].rules;
const src = "import Acme from 'acme-sdk';\nconst c = new Acme();\nc.charges.create({ amount_cents: 1 });\n";
const TOOL = { name: 'apimigrate', version: 'test' };

function run(files, rs = ruleSet(rules)) {
  const deterministic = applyRuleSet(rs, files);
  const gate = runGate({ base: files, head: deterministic.files });
  return { rs, deterministic, evidence: buildEvidence({ ruleSet: rs, before: files, deterministic, gate, tool: TOOL }) };
}
const strip = ({ meta, ...rest }) => rest;

test('evidence does not depend on file order, line endings or time', () => {
  const a = run({ 'a.ts': src, 'b.ts': 'export const x = 1;\n', 'c.ts': src });
  const crlf = (t) => normalize(t.replace(/\n/g, '\r\n')).text;
  const b = run({ 'c.ts': crlf(src), 'b.ts': crlf('export const x = 1;\n'), 'a.ts': crlf(src) });
  assert.deepEqual(strip(a.evidence), strip(b.evidence));
  assert.notEqual(a.evidence.meta.createdAt, undefined);
  const later = buildEvidence({ ruleSet: a.rs, before: { 'a.ts': src, 'b.ts': 'export const x = 1;\n', 'c.ts': src }, deterministic: a.deterministic, gate: a.evidence.gate, tool: TOOL, now: new Date(0) });
  assert.equal(later.deterministic.replayDigest, a.evidence.deterministic.replayDigest);
});

test('replay passes on the base tree and fails on drift, a changed rule or a bad schema', () => {
  const { keys, rs } = (() => { const k = generateKeys(); return { keys: k, rs: signRuleSet(ruleSet(rules), k.privatePem, 'k1') }; })();
  const base = { 'a.ts': src };
  const { evidence } = run(base, rs);
  assert.equal(replay(rs, base, evidence).ok, true);
  const drifted = replay(rs, { 'a.ts': src + '// drift\n' }, evidence);
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.drift, ['a.ts']);
  const other = { ...rs, sunset: '2100-01-01' };
  assert.match(replay(other, base, evidence).reason, /rule file differs/);
  assert.match(replay(rs, base, { ...evidence, schema: 'apimigrate-evidence/1' }).reason, /unsupported/);
  assert.ok(keys);
});

test('head check catches edits made after the migration, including deletions', () => {
  const base = { 'a.ts': src, 'keep.test.ts': 'expect(1).toBe(1);\n' };
  const { deterministic, evidence } = run(base);
  assert.equal(checkHead(base, deterministic.files, evidence).ok, true);
  const tampered = { ...deterministic.files, 'a.ts': deterministic.files['a.ts'] + 'steal();\n' };
  assert.deepEqual(checkHead(base, tampered, evidence).drift, ['a.ts']);
  const { 'keep.test.ts': _gone, ...withoutTest } = deterministic.files;
  assert.deepEqual(checkHead(base, withoutTest, evidence).drift, ['keep.test.ts']);
});

test('tree reading normalizes text, sorts paths and refuses to leave the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'tree-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'b.ts'), 'one\r\ntwo\r\n');
  writeFileSync(join(root, 'src', 'a.ts'), '﻿x\n');
  writeFileSync(join(root, 'src', 'notes.md'), 'ignored');
  const { files, styles } = readTree(root, { paths: ['src'] });
  assert.deepEqual(Object.keys(files), ['src/a.ts', 'src/b.ts']);
  assert.equal(files['src/b.ts'], 'one\ntwo\n');
  assert.equal(files['src/a.ts'], 'x\n');
  assert.deepEqual(styles['src/b.ts'], { eol: '\r\n', bom: false });
  assert.deepEqual(styles['src/a.ts'], { eol: '\n', bom: true });
  assert.throws(() => readTree(root, { paths: ['..'] }), /outside the repository root/);
  assert.throws(() => readTree(root, { paths: ['src/../../x'] }), /outside the repository root/);
  assert.equal(denormalize('one\ntwo\n', styles['src/b.ts']), 'one\r\ntwo\r\n');
});

test('writing restores line endings and touches only changed files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tree-'));
  writeFileSync(join(root, 'a.ts'), 'a\r\nb\r\n');
  writeFileSync(join(root, 'b.ts'), 'same\n');
  const { files, styles } = readTree(root);
  const written = writeChanged(root, files, { ...files, 'a.ts': 'a\nc\n' }, styles);
  assert.deepEqual(written, ['a.ts']);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'a\r\nc\r\n');
  assert.throws(() => writeChanged(root, files, { '../escape.ts': 'x' }, styles), /outside the repository root/);
});

test('symbolic links are not followed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tree-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'secret.ts'), 'secret');
  try { symlinkSync(outside, join(root, 'link'), 'dir'); } catch { return t.skip('symlinks not permitted here'); }
  assert.deepEqual(Object.keys(readTree(root).files), []);
});

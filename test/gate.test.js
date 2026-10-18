import test from 'node:test';
import assert from 'node:assert/strict';
import { isGateFile, runGate } from '../src/gate.js';
import { globToRegExp } from '../src/glob.js';

const T = 'a.test.ts';
const base = { [T]: "import { f } from './f';\ntest('a', () => {\n  expect(f(1)).toBe(2);\n  expect(f(2)).toEqual(4);\n});\n" };
const codes = (r) => r.findings.map((f) => `${f.code}@${f.file}:${f.line}`);
const gate = (head, extra = {}) => runGate({ base, head, ...extra });

test('an unchanged or equal test file passes', () => {
  assert.equal(gate(base).ok, true);
  assert.equal(gate({ [T]: base[T].replace('f(1)', 'g(1)') }).ok, true);
});

test('removed assertions and removed files name the file', () => {
  const r = gate({ [T]: base[T].replace('  expect(f(2)).toEqual(4);\n', '') });
  assert.deepEqual(codes(r), ['assertions-dropped-total@:0', 'assertions-dropped@a.test.ts:3']);
  assert.match(r.failures[1], /^a\.test\.ts: assertions dropped from 2 to 1$/);
  assert.deepEqual(codes(gate({})), ['assertions-dropped-total@:0', 'test-removed@a.test.ts:1']);
});

test('commenting an assertion out is caught even though the text remains', () => {
  const r = gate({ [T]: base[T].replace('  expect(f(2)).toEqual(4);', '  // expect(f(2)).toEqual(4);') });
  assert.ok(codes(r).includes('assertions-dropped@a.test.ts:3'));
  assert.ok(codes(r).includes('assertion-commented@a.test.ts:4'));
  assert.match(r.findings.find((f) => f.code === 'assertion-commented').message, /^a\.test\.ts:4: assertion or test commented out$/);
});

test('skipped, todo and focused tests are caught in every spelling', () => {
  const edits = [
    (s) => s.replace("test('a'", "test.skip('a'"),
    (s) => s.replace("test('a'", "xit('a'"),
    (s) => s.replace("test('a'", "it.only('a'"),
    (s) => s.replace("test('a', () => {", "test('a', { skip: true }, () => {"),
    (s) => s.replace("test('a', () => {", "describe.todo('a', () => {"),
  ];
  for (const edit of edits) {
    const r = gate({ [T]: edit(base[T]) });
    assert.ok(r.findings.some((f) => f.code === 'test-skipped'), edit(base[T]));
  }
  assert.equal(gate({ [T]: base[T].replace("test('a', () => {", "test('a', { skip: false }, () => {") }).ok, true);
});

test('weakened assertions are caught', () => {
  const weak = gate({ [T]: base[T].replace('.toBe(2)', '.toBeTruthy()') });
  assert.deepEqual(codes(weak), ['assertion-weakened@a.test.ts:3']);
  assert.match(weak.failures[0], /^a\.test\.ts:3: weak assertion added/);
  assert.ok(codes(gate({ [T]: base[T].replace('.toEqual(4)', '.toEqual(expect.anything())') })).includes('assertion-weakened@a.test.ts:4'));
  assert.ok(codes(gate({ [T]: base[T].replace('expect(f(1)).toBe(2)', 'expect(f(1))') })).includes('assertion-empty@a.test.ts:3'));
  assert.ok(codes(gate({ [T]: base[T].replace('expect(f(1)).toBe(2)', 'expect(true).toBe(true)') })).includes('assertion-tautology@a.test.ts:3'));
});

test('strings that look like assertions do not count', () => {
  const noisy = { [T]: "const s = 'expect(1).toBe(1)';\n// expect(2).toBe(2)\n" };
  const r = runGate({ base: noisy, head: { [T]: "const s = 'expect(1).toBe(1)';\n" } });
  assert.equal(r.assertions.before, 0);
});

test('CI and test config edits need an allow entry', () => {
  const b = { '.github/workflows/ci.yml': 'a: 1\nb: 2\nc: 3\n', 'jest.config.js': 'x', [T]: base[T] };
  const h = { ...b, '.github/workflows/ci.yml': 'a: 1\nb: 9\nc: 3\n' };
  const r = runGate({ base: b, head: h });
  assert.deepEqual(codes(r), ['protected-changed@.github/workflows/ci.yml:2']);
  assert.match(r.failures[0], /^\.github\/workflows\/ci\.yml:2: protected test or CI file changed$/);
  assert.equal(runGate({ base: b, head: h, allow: ['.github/workflows/ci.yml'] }).ok, true);
  assert.match(runGate({ base: b, head: { ...b, 'jest.config.js': 'y' } }).failures[0], /jest\.config\.js/);
  assert.match(runGate({ base: b, head: { [T]: base[T], 'jest.config.js': 'x' } }).failures[0], /removed/);
  assert.match(runGate({ base: b, head: { ...b, '.github/workflows/new.yml': 'x' } }).failures[0], /added/);
});

test('package.json only trips on test related settings', () => {
  const pkg = (o) => ({ 'package.json': JSON.stringify(o) });
  const b = pkg({ scripts: { test: 'node --test', build: 'tsc' }, dependencies: { a: '1' } });
  assert.equal(runGate({ base: b, head: pkg({ scripts: { test: 'node --test', build: 'tsc -b' }, dependencies: { a: '2' } }) }).ok, true);
  const r = runGate({ base: b, head: pkg({ scripts: { test: 'echo ok', build: 'tsc' }, dependencies: { a: '1' } }) });
  assert.deepEqual(codes(r), ['protected-changed@package.json:1']);
  assert.equal(runGate({ base: b, head: pkg({ scripts: { test: 'node --test' }, jest: { coverageThreshold: {} } }) }).ok, false);
});

test('coverage drops and missing coverage fail', () => {
  assert.match(gate(base, { coverageBase: 90, coverageHead: 80 }).failures[0], /dropped from 90% to 80%/);
  assert.equal(gate(base, { coverageBase: 90, coverageHead: 89.9, coverageTolerance: 0.5 }).ok, true);
  assert.match(gate(base, { coverageBase: 90, coverageHead: null }).failures[0], /missing/);
  assert.equal(gate(base, { coverageBase: null, coverageHead: null }).ok, true);
});

test('added secrets are reported with file and line but never the value', () => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const r = gate({ ...base, 'src/k.ts': `const a = 1;\nconst k = '${key}';\n` });
  assert.deepEqual(codes(r), ['secret-added@src/k.ts:2']);
  assert.ok(!JSON.stringify(r).includes(key));
  const same = runGate({ base: { 'src/k.ts': `const k = '${key}';\n` }, head: { 'src/k.ts': `const k = '${key}';\nconst b = 1;\n` } });
  assert.equal(same.ok, true, 'a secret already in the base is not new');
});

test('findings come out in a stable order', () => {
  const head = { [T]: base[T].replace('.toBe(2)', '.toBeTruthy()').replace('test(', 'test.skip('), 'a.ts': "const k = 'AKIAABCDEFGHIJKLMNOP';\n" };
  assert.deepEqual(codes(gate(head)), codes(gate(head)));
});

test('glob and file selection helpers', () => {
  assert.ok(globToRegExp('.github/workflows/**').test('.github/workflows/a/b.yml'));
  assert.ok(globToRegExp('**/jest.config.*').test('jest.config.js'));
  assert.ok(globToRegExp('**/jest.config.*').test('pkg/x/jest.config.ts'));
  assert.ok(!globToRegExp('*.md').test('docs/a.md'));
  assert.equal(isGateFile('test/x.js'), true);
  assert.equal(isGateFile('src/x.js'), false);
});

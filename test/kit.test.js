import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'apimigrate.js');
const KITS = [
  ['mux', 'mux-node-14-to-15.rules.json', [['@mux/mux-node', '14', '15']]],
  ['cloudflare', 'cloudflare-6-to-7.rules.json', [['cloudflare', '6', '7']]],
];
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

for (const [name, fileName, expected] of KITS) test(`the ${name} kit is unsigned, lints, and signs into an index with a throwaway key`, () => {
  const KIT = join(ROOT, 'providers', name, fileName);
  assert.equal(JSON.parse(readFileSync(KIT, 'utf8')).signature, undefined);
  const dir = mkdtempSync(join(tmpdir(), 'kit-'));
  const site = join(dir, 'site');
  mkdirSync(site);
  assert.equal(run('keygen', '--out', join(dir, 'k'), '--key-id', 'rehearsal').status, 0);
  const file = join(site, fileName);
  copyFileSync(KIT, file);
  assert.equal(run('lint', file).status, 0);
  assert.equal(run('sign', file, '--key', join(dir, 'k', 'apimigrate-private.pem'), '--key-id', 'rehearsal').status, 0);
  copyFileSync(join(dir, 'k', 'apimigrate-keys.json'), join(site, 'keys.json'));
  const out = join(dir, 'index.json');
  const r = run('index', site, '--base-url', 'https://example.com/rules', '--keys', join(site, 'keys.json'), '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).rules.map((e) => [e.package, e.from, e.to]), expected);
});

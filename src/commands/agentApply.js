import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyAgentResult } from '../agent.js';
import { UsageError } from '../errors.js';
import { checkHead, fileDigests } from '../evidence.js';
import { runGate } from '../gate.js';
import { unifiedDiff } from '../diffview.js';
import { writeChanged } from '../tree.js';
import { audit, loadConfig, loadJson, loadTrees, protectList, runTests } from './common.js';

export const spec = {
  name: 'agent-apply',
  summary: 'validate and apply an agent result for unresolved sites, through the same gate',
  usage: 'agent-apply --results agent.json [--root dir] [--test-cmd cmd] [--dry-run]',
  value: ['results', 'root', 'test-cmd'],
  bool: ['dry-run'],
  positional: 0,
  options: [
    ['--results file', 'JSON { "files": { path: full new content } }, only queued files are accepted'],
    ['--dry-run', 'print diffs and gate result, write nothing'],
  ],
};

export function run({ flags }, io) {
  if (!flags.results) throw new UsageError('agent-apply needs --results');
  const root = resolve(flags.root ?? '.');
  const dir = join(root, '.apimigrate');
  for (const f of ['evidence.json', 'unresolved.json', 'base.json']) if (!existsSync(join(dir, f))) throw new UsageError(`${f} not found in ${dir}, run apply first`);
  const evidence = loadJson(join(dir, 'evidence.json'), 'evidence bundle');
  const queue = loadJson(join(dir, 'unresolved.json'), 'queue');
  const base = loadJson(join(dir, 'base.json'), 'base snapshot');
  const cfg = loadConfig(root);

  const current = loadTrees(root, cfg, evidence.scan);
  const baseScan = Object.fromEntries(base.scan.map((f) => [f, base.files[f]]));
  const drift = checkHead(baseScan, current.scanFiles, evidence);
  if (!drift.ok) {
    io.err(`the working tree changed since apply: ${drift.drift.join(', ')}`);
    return 1;
  }

  const applied = applyAgentResult(loadJson(flags.results, 'agent result'), queue, current.scanFiles);
  if (!applied.ok) {
    for (const e of applied.errors) io.err(`agent result rejected: ${e}`);
    return 1;
  }
  const head = { ...current.files, ...applied.files };
  const gate = runGate({ base: base.files, head, protect: protectList(cfg), allow: cfg.allow, coverageTolerance: cfg.coverageTolerance });
  for (const f of gate.findings) io.err(`gate: ${f.message}`);
  if (!gate.ok) {
    io.err('agent edits were not written because the gate failed');
    return 1;
  }
  for (const f of applied.touched) io.out(unifiedDiff(f, current.scanFiles[f], applied.files[f]).trimEnd());
  if (flags['dry-run']) {
    io.out(`would write ${applied.touched.length} agent edited files, gate passed`);
    return 0;
  }

  writeChanged(root, current.scanFiles, applied.files, current.styles);
  const tests = flags['test-cmd'] ? runTests(flags['test-cmd'], root) : null;
  evidence.agent = { edited: fileDigests(current.scanFiles, applied.files) };
  evidence.files = fileDigests(baseScan, applied.files);
  evidence.gate = gate;
  evidence.tests = tests ?? evidence.tests;
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  audit(root, { event: 'agent-apply', rule: evidence.rule.id, edited: applied.touched.length, gate: true, tests: tests?.exitCode ?? null });
  io.out(`applied agent edits to ${applied.touched.length} files, gate passed`);
  if (tests && tests.exitCode !== 0) { io.err(`tests failed with exit code ${tests.exitCode}`); return 1; }
  return 0;
}

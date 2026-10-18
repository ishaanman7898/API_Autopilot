import { resolve } from 'node:path';
import { runGate } from '../gate.js';
import { loadConfig, loadTrees, protectList, readCoverage } from './common.js';

export const spec = {
  name: 'gate',
  summary: 'run only the cheat-proof gate between two trees',
  usage: 'gate <baseDir> <headDir> [--cov-base file --cov-head file]',
  value: ['cov-base', 'cov-head'],
  positional: 2,
  options: [['--cov-base file --cov-head file', 'istanbul coverage-summary.json for each tree']],
};

export function run({ pos, flags }, io) {
  const base = resolve(pos[0]);
  const cfg = loadConfig(base);
  const res = runGate({
    base: loadTrees(base, cfg).files,
    head: loadTrees(resolve(pos[1]), cfg).files,
    protect: protectList(cfg),
    allow: cfg.allow,
    coverageBase: readCoverage(flags['cov-base']),
    coverageHead: readCoverage(flags['cov-head']),
    coverageTolerance: cfg.coverageTolerance,
  });
  for (const f of res.findings) io.err(`gate: ${f.message}`);
  io.out(res.ok ? `gate passed, ${res.assertions.after} assertions (was ${res.assertions.before})` : `gate failed with ${res.findings.length} findings`);
  return res.ok ? 0 : 1;
}

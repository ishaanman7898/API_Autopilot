import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildQueue } from '../agent.js';
import { UsageError } from '../errors.js';
import { applyRuleSet } from '../engine.js';
import { buildEvidence } from '../evidence.js';
import { runGate } from '../gate.js';
import { hashRuleSet, isSunset } from '../rule.js';
import { TrustError, verifyRuleSet } from '../signing.js';
import { writeChanged } from '../tree.js';
import { TOOL } from '../version.js';
import { unifiedDiff } from '../diffview.js';
import { audit, loadConfig, loadKeys, loadRules, loadTrees, protectList, readCoverage, runTests } from './common.js';

export const spec = {
  name: 'apply',
  summary: 'apply a signed rule to a repository and write an evidence bundle',
  usage: 'apply --rules rules.json (--keys file | --pubkey file.pem | --well-known domain) [options]',
  value: ['rules', 'root', 'test-cmd', 'cov-base', 'cov-head', 'keys', 'pubkey', 'well-known', 'key-id'],
  bool: ['dry-run', 'diff', 'allow-unsigned', 'strict'],
  positional: 0,
  options: [
    ['--rules file', 'rule file (required)'],
    ['--root dir', 'repository root, default current directory'],
    ['--dry-run', 'print what would change as diffs and write nothing'],
    ['--diff', 'print diffs of the changes made'],
    ['--test-cmd cmd', 'run this command after applying; a failure fails the run'],
    ['--cov-base file --cov-head file', 'istanbul coverage-summary.json before and after'],
    ['--strict', 'exit 1 when call sites remain unresolved'],
    ['--allow-unsigned', 'skip signature checks, refused when pins are set; evidence records signed: false'],
  ],
};

export async function run({ flags }, io) {
  if (!flags.rules) throw new UsageError('apply needs --rules');
  const root = resolve(flags.root ?? '.');
  const cfg = loadConfig(root);
  const rs = loadRules(flags.rules);

  if (isSunset(rs)) throw new TrustError(`rule ${rs.id} has passed its sunset date ${rs.sunset}`, 'sunset');
  if (cfg.providers.length && !cfg.providers.includes(rs.provider)) throw new TrustError(`provider ${rs.provider} is not allowed by .apimigrate.yml`, 'provider');
  if (flags['allow-unsigned']) {
    if (cfg.pins.length) throw new TrustError('--allow-unsigned cannot be used when pins are set', 'pins');
    io.err('warning: signature checks skipped, evidence will record signed: false');
  } else {
    const res = verifyRuleSet(rs, await loadKeys(flags, rs));
    if (!res.ok) throw new TrustError(`refusing rule ${rs.id}: ${res.reason}`, 'signature');
    if (cfg.pins.length && !cfg.pins.includes(res.hash)) throw new TrustError(`rule hash ${res.hash} is not in the pins list of .apimigrate.yml`, 'pins');
  }

  const dry = Boolean(flags['dry-run']);
  const scan = { paths: cfg.paths, extensions: cfg.extensions };
  const before = loadTrees(root, cfg, scan);
  const result = applyRuleSet(rs, before.scanFiles, before.configs);
  const changed = Object.keys(result.files).filter((f) => before.scanFiles[f] !== result.files[f]);
  const gateOptions = { base: before.files, protect: protectList(cfg), allow: cfg.allow, coverageTolerance: cfg.coverageTolerance };
  const preview = { ...before.files, ...result.files };

  if (dry || flags.diff) for (const f of changed) io.out(unifiedDiff(f, before.scanFiles[f], result.files[f]).trimEnd());

  // Gate the rewrite in memory first, so a failing change never reaches the disk. Same order as agent-apply.
  if (!dry) {
    const pre = runGate({ ...gateOptions, head: preview });
    if (!pre.ok) {
      for (const f of pre.findings) io.err(`gate: ${f.message}`);
      io.err('nothing was written because the gate failed');
      audit(root, { event: 'apply', rule: rs.id, hash: hashRuleSet(rs), signed: Boolean(rs.signature), changedFiles: 0, unresolved: result.unresolved.length, gate: false, tests: null });
      return 1;
    }
    writeChanged(root, before.scanFiles, result.files, before.styles);
  }

  // Gate again after the tests run, because the test command can change files too.
  const tests = flags['test-cmd'] && !dry ? runTests(flags['test-cmd'], root) : null;
  const head = dry ? { files: preview } : loadTrees(root, cfg, scan);
  const gate = runGate({
    ...gateOptions,
    head: head.files,
    coverageBase: readCoverage(flags['cov-base']),
    coverageHead: readCoverage(flags['cov-head']),
  });
  const evidence = buildEvidence({ ruleSet: rs, before: before.scanFiles, deterministic: result, gate, tests, tool: TOOL, scan });

  if (!dry) {
    const dir = join(root, '.apimigrate');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(join(dir, 'base.json'), JSON.stringify({ files: before.files, scan: Object.keys(before.scanFiles) }) + '\n');
    writeFileSync(join(dir, 'unresolved.json'), JSON.stringify(buildQueue(result.unresolved, rs), null, 2) + '\n');
    audit(root, { event: 'apply', rule: rs.id, hash: evidence.rule.contentHash, signed: evidence.rule.signed, changedFiles: changed.length, unresolved: result.unresolved.length, gate: gate.ok, tests: tests?.exitCode ?? null });
  }

  const unproven = result.changes.filter((c) => !c.proven).length;
  io.out(`${dry ? 'would change' : 'changed'} ${result.changes.length} call sites in ${changed.length} files, ${result.unresolved.length} unresolved`);
  for (const u of result.unresolved) io.out(`unresolved: ${u.file}:${u.line} ${u.ruleId}: ${u.reason}`);
  for (const s of [...result.skipped, ...before.skipped]) io.out(`skipped: ${s.file}: ${s.reason}`);
  if (unproven) io.out(`note: ${unproven} changes came from regex replace rules and are not parse-verified`);
  if (changed.some((f) => /(?:^|\/)package\.json$/.test(f))) io.out('note: package.json dependencies changed, update the lockfile with your package manager before merging');
  if (result.unresolved.length && !dry) io.out('unresolved sites are queued in .apimigrate/unresolved.json for an agent, then run agent-apply');
  for (const f of gate.findings) io.err(`gate: ${f.message}`);
  if (tests && tests.exitCode !== 0) io.err(`tests failed with exit code ${tests.exitCode}`);
  if (flags.strict && result.unresolved.length) io.err('strict: unresolved call sites remain');
  const failed = !gate.ok || (tests && tests.exitCode !== 0) || (flags.strict && result.unresolved.length > 0);
  return failed ? 1 : 0;
}

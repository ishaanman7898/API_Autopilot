import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildQueue } from '../agent.js';
import { UsageError } from '../errors.js';
import { applyRuleSet } from '../engine.js';
import { buildEvidence } from '../evidence.js';
import { installDependencies } from '../install.js';
import { runGate } from '../gate.js';
import { hashRuleSet, isSunset } from '../rule.js';
import { TrustError, verifyRuleSet } from '../signing.js';
import { writeChanged } from '../tree.js';
import { typecheckBaseline, typecheckChanges } from '../typecheck.js';
import { TOOL } from '../version.js';
import { unifiedDiff } from '../diffview.js';
import { audit, loadConfig, loadKeys, loadRules, loadTrees, outputTail, protectList, readCoverage, runTests } from './common.js';

export const spec = {
  name: 'apply',
  summary: 'apply a signed rule to a repository and write an evidence bundle',
  usage: 'apply --rules rules.json (--keys file | --pubkey file.pem | --well-known domain) [options]',
  value: ['rules', 'root', 'test-cmd', 'install-cmd', 'cov-base', 'cov-head', 'keys', 'pubkey', 'well-known', 'key-id'],
  bool: ['dry-run', 'diff', 'allow-unsigned', 'strict', 'install', 'typecheck'],
  positional: 0,
  options: [
    ['--rules file', 'rule file (required)'],
    ['--root dir', 'repository root, default current directory'],
    ['--dry-run', 'print what would change as diffs and write nothing'],
    ['--diff', 'print diffs of the changes made'],
    ['--install', 'when package.json changed, install with the package manager its lockfile names, without install scripts, before tests'],
    ['--install-cmd cmd', 'when package.json changed, run this command at the root instead of --install'],
    ['--test-cmd cmd', 'run this command after applying; a failure fails the run'],
    ['--typecheck', 'with --install or --install-cmd, type-check the changed files before and after the rewrite; an error added on a changed line fails the gate'],
    ['--cov-base file --cov-head file', 'istanbul coverage-summary.json before and after'],
    ['--strict', 'exit 1 when call sites remain unresolved'],
    ['--allow-unsigned', 'skip signature checks, refused when pins are set; evidence records signed: false'],
  ],
};

export async function run({ flags }, io) {
  if (!flags.rules) throw new UsageError('apply needs --rules');
  if (flags.typecheck && !flags.install && !flags['install-cmd']) throw new UsageError('--typecheck needs --install or --install-cmd, since without the new versions installed it would check against the old ones');
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

  // New dependency versions are installed before the tests, so the tests run against them.
  const manifests = changed.filter((f) => /(?:^|\/)package\.json$/.test(f));
  const installing = !dry && manifests.length > 0 && Boolean(flags.install || flags['install-cmd']);
  // The original text is type-checked against the old versions first. An error it already had there can be
  // hidden by another one at the same call once the new versions are in, and must not count against the rewrite.
  let baseline = null;
  let typecheckError = null;
  if (flags.typecheck && installing) {
    try { baseline = typecheckBaseline(root, before.scanFiles, result.files); } catch (e) { typecheckError = e; }
  }
  const installed = installing ? installDependencies(root, manifests, { cmd: flags['install-cmd'] ?? null }) : null;
  const install = installed && { runs: installed.runs, lockfiles: installed.lockfiles };

  // Gate again after the tests run, because the test command can change files too.
  const ran = flags['test-cmd'] && !dry && installed?.ok !== false ? runTests(flags['test-cmd'], root) : null;
  const tests = ran?.result ?? null;
  const head = dry ? { files: preview } : loadTrees(root, cfg, scan);
  // After the install and the tests, the original text and the text as tested are checked against the new versions.
  let typecheck = null;
  if (flags.typecheck) {
    const skip = dry ? '--dry-run installs nothing' : !installed ? 'no package.json changed, so no new versions were installed' : !installed.ok ? 'the install failed' : null;
    try {
      if (typecheckError) throw typecheckError;
      typecheck = skip ? { ran: false, reason: skip } : typecheckChanges(root, before.scanFiles, head.scanFiles, baseline);
    } catch (e) {
      typecheckError = e;
      typecheck = { ran: false, reason: `TypeScript failed: ${e.message}` };
    }
  }
  const gate = runGate({
    ...gateOptions,
    head: head.files,
    coverageBase: readCoverage(flags['cov-base']),
    coverageHead: readCoverage(flags['cov-head']),
    typeErrors: typecheck?.added ?? [],
  });
  const evidence = buildEvidence({ ruleSet: rs, before: before.scanFiles, deterministic: result, gate, tests, install, typecheck, tool: TOOL, scan });

  if (!dry) {
    const dir = join(root, '.apimigrate');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(join(dir, 'base.json'), JSON.stringify({ files: before.files, scan: Object.keys(before.scanFiles) }) + '\n');
    writeFileSync(join(dir, 'unresolved.json'), JSON.stringify(buildQueue(result.unresolved, rs), null, 2) + '\n');
    audit(root, { event: 'apply', rule: rs.id, hash: evidence.rule.contentHash, signed: evidence.rule.signed, changedFiles: changed.length, unresolved: result.unresolved.length, gate: gate.ok, tests: tests?.exitCode ?? null, install: install ? installed.ok : null, typeErrorsAdded: typecheck?.ran ? typecheck.added.length : null });
  }

  const unproven = result.changes.filter((c) => !c.proven).length;
  io.out(`${dry ? 'would change' : 'changed'} ${result.changes.length} call sites in ${changed.length} files, ${result.unresolved.length} unresolved`);
  for (const u of result.unresolved) io.out(`unresolved: ${u.file}:${u.line} ${u.ruleId}: ${u.reason}`);
  for (const s of [...result.skipped, ...before.skipped]) io.out(`skipped: ${s.file}: ${s.reason}`);
  if (unproven) io.out(`note: ${unproven} changes came from regex replace rules and are not parse-verified`);
  if (installed?.ok) io.out(`installed with ${installed.runs.map((r) => `${r.cmd} in ${r.dir}`).join(', ')}${install.lockfiles.length ? `, updated ${install.lockfiles.map((l) => l.path).join(', ')}` : ''}`);
  else if (manifests.length && !installed) io.out('note: package.json dependencies changed, update the lockfile with your package manager before merging');
  if (installed && !installed.ok) {
    const r = installed.runs.at(-1);
    io.err(`install failed: ${r.cmd} in ${r.dir} exited with ${r.exitCode}, tests were not run`);
    if (installed.output) io.err(installed.output);
  }
  if (typecheck?.ran) {
    const n = typecheck.projects.reduce((k, p) => k + p.files.length, 0);
    io.out(`type-checked ${n} changed files with TypeScript ${typecheck.typescript}: ${typecheck.added.length} errors added on changed lines`);
    for (const e of typecheck.otherLines) io.out(`note: new type error on a line the rewrite did not change, not counted by the gate: ${e.file}:${e.line}: ${e.code} ${e.message}`);
  } else if (typecheckError) io.err(`warning: type-check not run: ${typecheck.reason}`);
  else if (typecheck) io.out(`note: type-check not run: ${typecheck.reason}`);
  if (result.unresolved.length && !dry) io.out('unresolved sites are queued in .apimigrate/unresolved.json for an agent, then run agent-apply');
  for (const f of gate.findings) io.err(`gate: ${f.message}`);
  if (tests && tests.exitCode !== 0) {
    io.err(`tests failed with exit code ${tests.exitCode}, the last lines of their output follow`);
    if (ran.output.trim()) io.err(outputTail(ran.output));
  }
  if (flags.strict && result.unresolved.length) io.err('strict: unresolved call sites remain');
  const failed = !gate.ok || installed?.ok === false || (tests && tests.exitCode !== 0) || (flags.strict && result.unresolved.length > 0);
  return failed ? 1 : 0;
}

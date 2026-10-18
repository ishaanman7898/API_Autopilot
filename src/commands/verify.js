import { resolve } from 'node:path';
import { UsageError } from '../errors.js';
import { checkHead, replay } from '../evidence.js';
import { TrustError, verifyRuleSet } from '../signing.js';
import { loadConfig, loadJson, loadKeys, loadRules, loadTrees } from './common.js';

export const spec = {
  name: 'verify',
  summary: 'replay a migration on a base checkout and compare it with an evidence bundle',
  usage: 'verify --rules rules.json --evidence evidence.json [--root baseDir] [--head headDir] [key options]',
  value: ['rules', 'evidence', 'root', 'head', 'keys', 'pubkey', 'well-known', 'key-id'],
  positional: 0,
  options: [
    ['--root dir', 'checkout of the base commit, default current directory'],
    ['--head dir', 'checkout of the pull request head, checked against the bundle including agent edits'],
    ['--keys, --pubkey or --well-known', 'also verify the rule signature'],
  ],
};

export async function run({ flags }, io) {
  if (!flags.rules || !flags.evidence) throw new UsageError('verify needs --rules and --evidence');
  const rs = loadRules(flags.rules);
  const evidence = loadJson(flags.evidence, 'evidence bundle');
  const signed = ['keys', 'pubkey', 'well-known'].some((k) => flags[k]);
  if (signed) {
    const res = verifyRuleSet(rs, await loadKeys(flags, rs));
    if (!res.ok) throw new TrustError(`rule signature: ${res.reason}`, 'signature');
    io.out(`rule signature valid, key ${res.keyId}`);
  } else io.out('note: rule signature not checked, pass --keys, --pubkey or --well-known');

  const root = resolve(flags.root ?? '.');
  const cfg = loadConfig(root);
  const scan = evidence.scan ?? { paths: cfg.paths, extensions: cfg.extensions };
  const base = loadTrees(root, cfg, scan);
  const replayed = replay(rs, base.scanFiles, evidence, base.configs);
  if (!replayed.ok) {
    io.err(`replay failed: ${replayed.reason}`);
    for (const f of replayed.drift ?? []) io.err(`  differs: ${f}`);
    return 1;
  }
  io.out(`replay matches ${replayed.digest}`);
  if (evidence.unresolved.length) io.out(`${evidence.unresolved.length} unresolved sites are not replayed`);

  if (flags.head) {
    const head = loadTrees(resolve(flags.head), cfg, scan);
    const checked = checkHead(base.scanFiles, head.scanFiles, evidence);
    if (!checked.ok) {
      io.err(`head check failed: ${checked.reason}`);
      for (const f of checked.drift) io.err(`  differs: ${f}`);
      return 1;
    }
    io.out('head tree matches the evidence');
  }
  return 0;
}

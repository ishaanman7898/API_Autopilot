import { readFileSync, writeFileSync } from 'node:fs';
import { UsageError } from '../errors.js';
import { signingBlockers } from '../rule.js';
import { signRuleSet } from '../signing.js';
import { loadRules } from './common.js';

export const spec = {
  name: 'sign',
  summary: 'sign a rule file',
  usage: 'sign <rules.json> --key private.pem [--key-id id] [--out file]',
  value: ['key', 'key-id', 'out'],
  positional: 1,
  options: [['--key file', 'ed25519 private key in PEM form (required)'], ['--key-id id', 'key id as published, default k1'], ['--out file', 'write here instead of in place']],
};

export function run({ pos, flags }, io) {
  if (!flags.key) throw new UsageError('sign needs --key');
  const rs = loadRules(pos[0]);
  const blockers = signingBlockers(rs);
  if (blockers.length) throw new UsageError(`refusing to sign:\n  ${blockers.join('\n  ')}\nreview each rule, then remove "draft" and every "confidence" field`);
  let pem;
  try { pem = readFileSync(flags.key, 'utf8'); } catch (e) { throw new UsageError(`cannot read key ${flags.key}: ${e.message}`); }
  const signed = signRuleSet(rs, pem, flags['key-id'] ?? 'k1');
  writeFileSync(flags.out ?? pos[0], JSON.stringify(signed, null, 2) + '\n');
  io.out(`signed ${signed.id} hash=${signed.signature.hash} key=${signed.signature.keyId}`);
  return 0;
}

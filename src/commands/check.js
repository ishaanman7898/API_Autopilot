import { isSunset } from '../rule.js';
import { verifyRuleSet } from '../signing.js';
import { loadJson, loadKeys } from './common.js';

export const spec = {
  name: 'check',
  summary: 'verify a rule file signature against published keys',
  usage: 'check <rules.json> (--keys file | --pubkey file.pem | --well-known domain) [--key-id id]',
  value: ['keys', 'pubkey', 'well-known', 'key-id'],
  positional: 1,
  options: [['--keys file', 'key set JSON'], ['--pubkey file', 'one PEM public key, with --key-id if the rule has none'], ['--well-known domain', 'fetch https://domain/.well-known/apimigrate-keys.json']],
};

export async function run({ pos, flags }, io) {
  const rs = loadJson(pos[0], 'rule file');
  const res = verifyRuleSet(rs, await loadKeys(flags, rs));
  if (!res.ok) { io.err(`invalid: ${res.reason}`); return 3; }
  io.out(`valid ${res.hash} key=${res.keyId}`);
  if (isSunset(rs)) { io.err(`rule ${rs.id} has passed its sunset date ${rs.sunset}`); return 3; }
  return 0;
}

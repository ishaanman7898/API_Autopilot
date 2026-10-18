import { loadRules } from './common.js';
import { signingBlockers } from '../rule.js';

export const spec = {
  name: 'lint',
  summary: 'validate a rule file',
  usage: 'lint <rules.json>',
  positional: 1,
  options: [],
};

export function run({ pos }, io) {
  const rs = loadRules(pos[0]);
  const blockers = signingBlockers(rs);
  for (const b of blockers) io.out(`not signable: ${b}`);
  io.out(`${rs.id}: ${rs.rules.length} rules, sunset ${rs.sunset}${blockers.length ? '' : ', ready to sign'}`);
  return 0;
}

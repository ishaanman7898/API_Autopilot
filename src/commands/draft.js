import { readFileSync, writeFileSync } from 'node:fs';
import { UsageError } from '../errors.js';
import { NAMINGS, diffSpecs, draftRules } from '../diff.js';

export const spec = {
  name: 'draft',
  summary: 'draft rules from two OpenAPI 3.x specs in JSON',
  usage: 'draft <old-spec.json> <new-spec.json> [--provider p] [--package name] [--from v] [--to v] [--naming underscore|identity] [--out file]',
  value: ['provider', 'package', 'from', 'to', 'naming', 'out'],
  positional: 2,
  options: [
    ['--naming name', 'how operationId maps to the SDK method; without it every rename is marked needs-review'],
    ['--out file', 'rule file to write, default draft-rules.json; a .report.json is written beside it'],
  ],
};

function readSpec(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new UsageError(`cannot read ${path}: ${e.message}`); }
  try { return JSON.parse(text); } catch { throw new UsageError(`${path} is not JSON. YAML specs are not supported, convert to JSON first.`); }
}

export function run({ pos, flags }, io) {
  if (flags.naming && !NAMINGS[flags.naming]) throw new UsageError(`unknown naming ${flags.naming}, use ${Object.keys(NAMINGS).join(' or ')}`);
  let diff;
  try { diff = diffSpecs(readSpec(pos[0]), readSpec(pos[1])); } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(e.message);
  }
  const { ruleSet, report } = draftRules(diff, { provider: flags.provider ?? 'provider', pkg: flags.package ?? 'sdk', from: flags.from ?? 'old', to: flags.to ?? 'new', naming: flags.naming ?? null });
  const out = flags.out ?? 'draft-rules.json';
  writeFileSync(out, JSON.stringify(ruleSet, null, 2) + '\n');
  writeFileSync(out.replace(/\.json$/, '') + '.report.json', JSON.stringify(report, null, 2) + '\n');
  io.out(`${ruleSet.rules.length} draft rules written to ${out}: ${report.likely} likely, ${report.needsReview} needs-review`);
  io.out('drafts are not signable until you review them and remove "draft" and each "confidence" field');
  return 0;
}

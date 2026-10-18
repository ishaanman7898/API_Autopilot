import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { UsageError } from '../errors.js';
import { NAMINGS, diffSpecs, draftRules } from '../diff.js';
import { diffSurfaces, draftFromSurfaces, readApiSurface } from '../apimd.js';

export const spec = {
  name: 'draft',
  summary: 'draft rules from two OpenAPI 3.x specs in JSON, or two SDK checkouts with api.md',
  usage: 'draft <old> <new> [--provider p] [--package name] [--from v] [--to v] [--naming underscore|identity] [--out file]',
  value: ['provider', 'package', 'from', 'to', 'naming', 'out'],
  positional: 2,
  options: [
    ['<old> <new>', 'two OpenAPI JSON files, or two SDK folders that each contain api.md'],
    ['--naming name', 'OpenAPI only: how operationId maps to the SDK method; without it every rename is marked needs-review'],
    ['--out file', 'rule file to write, default draft-rules.json; a .report.json is written beside it'],
  ],
};

function readSpec(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new UsageError(`cannot read ${path}: ${e.message}`); }
  try { return JSON.parse(text); } catch { throw new UsageError(`${path} is not JSON. YAML specs are not supported, convert to JSON first.`); }
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Two SDK checkouts: package name and versions come from their package.json unless given as flags.
function fromSdks(oldDir, newDir, flags) {
  if (flags.naming) throw new UsageError('--naming applies to OpenAPI specs, not SDK folders');
  let a;
  let b;
  try { a = readApiSurface(oldDir); b = readApiSurface(newDir); } catch (e) { throw new UsageError(e.message); }
  const oldName = flags.package ?? a.name;
  if (!oldName) throw new UsageError(`${oldDir} has no package.json name, pass --package`);
  return draftFromSurfaces(diffSurfaces(a, b), {
    provider: flags.provider ?? 'provider',
    from: flags.from ?? a.version ?? 'old',
    to: flags.to ?? b.version ?? 'new',
    oldName,
    newName: b.name ?? oldName,
    newVersion: b.version,
    oldMethods: [...a.methods.values()].flat().map((m) => m.call),
  });
}

export function run({ pos, flags }, io) {
  let drafted;
  if (isDir(pos[0]) || isDir(pos[1])) {
    if (!isDir(pos[0]) || !isDir(pos[1])) throw new UsageError('pass two SDK folders or two spec files, not one of each');
    drafted = fromSdks(pos[0], pos[1], flags);
  } else {
    if (flags.naming && !NAMINGS[flags.naming]) throw new UsageError(`unknown naming ${flags.naming}, use ${Object.keys(NAMINGS).join(' or ')}`);
    let diff;
    try { diff = diffSpecs(readSpec(pos[0]), readSpec(pos[1])); } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError(e.message);
    }
    drafted = draftRules(diff, { provider: flags.provider ?? 'provider', pkg: flags.package ?? 'sdk', from: flags.from ?? 'old', to: flags.to ?? 'new', naming: flags.naming ?? null });
  }
  const { ruleSet, report } = drafted;
  const out = flags.out ?? 'draft-rules.json';
  writeFileSync(out, JSON.stringify(ruleSet, null, 2) + '\n');
  writeFileSync(out.replace(/\.json$/, '') + '.report.json', JSON.stringify(report, null, 2) + '\n');
  io.out(`${ruleSet.rules.length} draft rules written to ${out}: ${report.likely} likely, ${report.needsReview} needs-review`);
  io.out('drafts are not signable until you review them and remove "draft" and each "confidence" field');
  return 0;
}

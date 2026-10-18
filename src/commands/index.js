import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, UsageError } from '../errors.js';
import { loadKeySetFile } from '../keys.js';
import { lineOf } from '../registry.js';
import { isSunset, signingBlockers, validateRuleSet } from '../rule.js';
import { verifyRuleSet } from '../signing.js';

export const spec = {
  name: 'index',
  summary: 'build the rule index a provider publishes at /.well-known/apimigrate-rules.json',
  usage: 'index <rules dir> --base-url https://acme.com/rules --keys apimigrate-keys.json [--out file]',
  value: ['base-url', 'keys', 'out'],
  positional: 1,
  options: [
    ['--base-url url', 'https URL the rule files are served from (required)'],
    ['--keys file', 'the key set the same domain publishes (required)'],
    ['--out file', 'write the index here instead of printing it'],
  ],
};

// A rule file names its versions as "1.x", "14", "^2.3.0" or "0.44.x". The line is the major, or 0.minor
// below 1.0, so "0.x" names no line.
export function versionLine(v) {
  const m = /^[\^~]?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:[-+].*)?$/i.exec(typeof v === 'string' ? v.trim() : '');
  const minor = /^\d+$/.test(m?.[2] ?? '') ? m[2] : null;
  if (!m || (Number(m[1]) === 0 && minor === null)) return null;
  return lineOf(`${m[1]}.${minor ?? 0}.0`);
}

const byLine = (a, b) => {
  const [x, y] = [a, b].map((l) => l.split('.').map(Number));
  return x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0);
};

// Every *.json file in the folder must be a valid, signed, unexpired rule file for one package and one pair
// of lines. Any refusal writes nothing.
export function run({ pos, flags }, io) {
  if (!flags['base-url'] || !flags.keys) throw new UsageError('index needs --base-url and --keys');
  let base = null;
  try { base = new URL(flags['base-url']); } catch { /* reported below */ }
  if (base?.protocol !== 'https:' || base.search || base.hash || base.username || base.password) throw new UsageError(`--base-url must be an https URL with no query, such as https://acme.com/rules`);
  const prefix = base.href.replace(/\/*$/, '/');
  if (flags.keys.endsWith('.pem')) throw new UsageError('--keys must be the key set JSON the domain publishes, not a PEM file');
  const keys = loadKeySetFile(flags.keys);
  const dir = pos[0];
  const skip = [flags.keys, flags.out].filter(Boolean).map((p) => resolve(p));
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json') && !skip.includes(resolve(dir, f))).sort(); } catch (e) { throw new UsageError(`cannot read ${dir}: ${e.message}`); }
  if (!names.length) throw new UsageError(`${dir} has no .json rule files`);

  const now = new Date();
  const refused = [];
  const entries = new Map();
  for (const name of names) {
    const refuse = (reason, trust = false) => refused.push({ name, reason, trust });
    let rs;
    try { rs = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch (e) { refuse(`cannot read it as JSON: ${e.message}`); continue; }
    const errors = validateRuleSet(rs);
    if (errors.length) { refuse(`not a valid rule file: ${errors.join(', ')}`); continue; }
    const blockers = signingBlockers(rs);
    if (blockers.length) { refuse(blockers.join(', ')); continue; }
    if (!rs.package) { refuse('has no package, so watch cannot match it'); continue; }
    const verified = verifyRuleSet(rs, keys, now);
    if (!verified.ok) { refuse(verified.reason, true); continue; }
    if (isSunset(rs, now)) { refuse(`has passed its sunset date ${rs.sunset}`, true); continue; }
    const from = versionLine(rs.from);
    const to = versionLine(rs.to);
    if (!from || !to) { refuse(`${from ? `to "${rs.to}"` : `from "${rs.from}"`} names no version line, such as "2.x", or "0.44.x" below 1.0`); continue; }
    if (byLine(from, to) >= 0) { refuse(`to line ${to} is not after from line ${from}`); continue; }
    const key = JSON.stringify([rs.package, from, to]);
    if (entries.has(key)) { refuse(`${rs.package} ${from} to ${to} is already in ${entries.get(key).name}`); continue; }
    entries.set(key, { name, entry: { package: rs.package, from, to, url: prefix + encodeURIComponent(name) } });
  }
  if (refused.length) {
    io.err(`error: refusing to build the index, nothing was written:\n${refused.map((r) => `  ${r.name}: ${r.reason}`).join('\n')}`);
    return refused.some((r) => r.trust) ? EXIT.trust : EXIT.usage;
  }

  const rules = [...entries.values()].map((e) => e.entry)
    .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : byLine(a.from, b.from) || byLine(a.to, b.to)));
  const text = JSON.stringify({ rules }, null, 2) + '\n';
  if (!flags.out) return io.out(text.trimEnd()), EXIT.ok;
  writeFileSync(flags.out, text);
  for (const r of rules) io.out(`${r.package} ${r.from} to ${r.to}: ${r.url}`);
  io.out(`wrote ${flags.out}, publish it at https://<domain>/.well-known/apimigrate-rules.json next to the key set`);
  return EXIT.ok;
}

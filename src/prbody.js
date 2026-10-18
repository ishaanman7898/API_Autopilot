import { lineOf } from './registry.js';

const MAX_BODY = 60000;
const MAX_EVIDENCE = 30000;

// Values come from repo paths and rule text, so they are flattened before they reach markdown.
const code = (s) => '`' + String(s).replace(/[`\r\n]/g, '') + '`';

export const changedPaths = (evidence) => evidence.files.filter((f) => f.after !== null).map((f) => f.path);

export function branchName(evidence, runId) {
  const slug = evidence.rule.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'rule';
  return `apimigrate/${slug}-${String(runId).replace(/[^0-9]/g, '') || '0'}`;
}

export function prBody(evidence, { rulesPath = 'rules.json', limit = MAX_BODY } = {}) {
  const unproven = evidence.callSites.filter((c) => !c.proven).length;
  const g = evidence.gate;
  const rows = [
    ['Rule', `${code(evidence.rule.id)} from ${code(evidence.rule.provider)}`],
    ['Rule hash', code(evidence.rule.contentHash)],
    ['Signed', evidence.rule.signed ? `yes, key ${code(evidence.rule.keyId)}` : 'no'],
    ['Files changed', String(changedPaths(evidence).length)],
    ['Call sites changed', `${evidence.callSites.length}${unproven ? `, ${unproven} from regex rules and not parse-verified` : ''}`],
    ['Unresolved call sites', String(evidence.unresolved.length)],
    ['Gate', g.ok ? 'passed' : `failed, ${g.findings.length} findings`],
    ['Tests', evidence.tests ? `exit code ${evidence.tests.exitCode}` : 'not run'],
    ['Replay digest', code(evidence.deterministic.replayDigest)],
  ];
  const lines = [
    `## Migration ${code(evidence.rule.id)}`,
    '',
    'Opened as a draft by apimigrate. It never merges itself. Review every change before marking it ready.',
    '',
    '| | |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ];
  if (changedPaths(evidence).some((p) => /(?:^|\/)package\.json$/.test(p))) {
    lines.push('', '`package.json` dependencies changed. Regenerate the lockfile with your package manager, for example `npm install`, and commit it before marking this ready.');
  }
  if (evidence.unresolved.length) {
    lines.push('', '### Unresolved call sites', '', 'These were not rewritten because the tool could not prove them.', '');
    for (const u of evidence.unresolved.slice(0, 50)) lines.push(`- ${code(`${u.file}:${u.line}`)} ${code(u.ruleId)}: ${String(u.reason).replace(/[\r\n]+/g, ' ')}`);
    if (evidence.unresolved.length > 50) lines.push(`- and ${evidence.unresolved.length - 50} more in the evidence bundle`);
  }
  lines.push(
    '', '### Verify', '',
    'Check out the base commit of this pull request and the head in a second directory, then run:',
    '',
    '```sh',
    `apimigrate verify --rules ${String(rulesPath).replace(/[`\r\n]/g, '')} --evidence evidence.json --root <base checkout> --head <head checkout>${evidence.rule.signed ? ' --well-known <provider domain>' : ''}`,
    '```',
  );
  const json = JSON.stringify(evidence, null, 2);
  const shown = json.length > MAX_EVIDENCE ? json.slice(0, MAX_EVIDENCE) + '\n... truncated, see the uploaded evidence artifact' : json;
  lines.push('', '<details><summary>Evidence bundle</summary>', '', '```json', shown.replace(/```/g, "'''"), '```', '', '</details>');
  return lines.join('\n').slice(0, limit) + '\n';
}

// Pull requests that `watch` opens, one per upgrade. A draft gets its own branch, so signed rules published
// later still get a pull request, and the branch name has no version beyond the lines, so a newer release
// on the same line does not open a second one.
const cell = (s, max = 200) => code(String(s).replace(/\|/g, '/').slice(0, max));
const slugOf = (s) => String(s).replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'package';

export const watchBranch = (entry) => `apimigrate/${slugOf(entry.package)}-${slugOf(entry.line)}-to-${slugOf(lineOf(entry.to))}${entry.source === 'signed' ? '' : '-unsigned'}`;

export function watchTitle(entry) {
  const what = `API migration: ${String(entry.package).replace(/[\r\n]/g, '')} ${entry.from} to ${entry.to}`;
  return entry.source === 'signed' ? what : `[unsigned draft] ${what}`;
}

export function watchBody(entry, evidence, ruleSet, { rulesPath = 'rules.json' } = {}) {
  const at = (u) => `${u.repo}@${u.ref}${u.dir ? ` in ${u.dir}` : ''}`;
  const lines = [];
  if (entry.source === 'signed') {
    lines.push(`Rules for ${code(entry.package)} ${code(entry.from)} to ${code(entry.to)}, signed by ${code(entry.domain)} with key ${code(entry.keyId)} and fetched from ${code(entry.url)}.`);
  } else {
    lines.push(
      '> [!WARNING]',
      `> **Unsigned.** No signed rules were found for ${code(entry.package)} ${code(entry.from)} to ${code(entry.to)}, so apimigrate drafted them from the api.md files of the two releases, ${cell(at(entry.upstream.from))} and ${cell(at(entry.upstream.to))}. Nobody has reviewed these rules, and the provider has not signed them. ${entry.needsReview} of ${entry.ruleCount} are marked needs-review. Read every change before marking this ready.`,
    );
    for (const n of entry.notes ?? []) lines.push('>', `> ${cell(n, 400)}`);
  }
  if (entry.deprecated) lines.push('', `The latest release is deprecated on npm: ${cell(entry.deprecated, 400)}`);
  const rules = ruleSet.rules ?? [];
  lines.push('', entry.source === 'signed' ? '### Rules' : '### Drafted rules', '', '| Rule | Kind | Confidence | Evidence |', '| --- | --- | --- | --- |');
  for (const r of rules.slice(0, 100)) lines.push(`| ${cell(r.id, 100)} | ${cell(r.kind)} | ${r.confidence ? cell(r.confidence) : 'signed'} | ${r.evidence ? cell(r.evidence) : ''} |`);
  if (rules.length > 100) lines.push(`| and ${rules.length - 100} more in the uploaded rule file | | | |`);
  const head = lines.join('\n').slice(0, 20000) + '\n\n';
  return head + prBody(evidence, { rulesPath, limit: MAX_BODY - head.length });
}

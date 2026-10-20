import { lineOf } from './registry.js';

const MAX_BODY = 60000;
const MAX_EVIDENCE = 30000;

// Values come from repo paths and rule text, so they are flattened before they reach markdown.
const code = (s) => '`' + String(s).replace(/[`\r\n]/g, '') + '`';

// Lockfiles that the install updated are committed with the rewritten files.
export const changedPaths = (evidence) => [...new Set([...evidence.files, ...(evidence.install?.lockfiles ?? [])].filter((f) => f.after !== null).map((f) => f.path))].sort();

export function branchName(evidence, runId) {
  const slug = evidence.rule.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'rule';
  return `apimigrate/${slug}-${String(runId).replace(/[^0-9]/g, '') || '0'}`;
}

function typecheckText(t) {
  if (!t.ran) return `not run: ${String(t.reason).replace(/[|`\r\n]+/g, ' ')}`;
  const files = t.projects.reduce((n, p) => n + p.files.length, 0);
  return `${files} files with TypeScript ${code(t.typescript)}, ${t.added.length} errors added on changed lines${t.otherLines.length ? `, ${t.otherLines.length} new on other lines` : ''}`;
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
    ...(evidence.install ? [['Install', evidence.install.runs.map((r) => `${code(r.cmd)} in ${code(r.dir)}, exit code ${r.exitCode}`).join('<br>')]] : []),
    ['Tests', evidence.tests ? `exit code ${evidence.tests.exitCode}` : 'not run'],
    ...(evidence.typecheck ? [['Type check', typecheckText(evidence.typecheck)]] : []),
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
  const lockfiles = evidence.install?.lockfiles ?? [];
  if (lockfiles.length) {
    lines.push('', `The new dependency versions were installed without running install scripts, and ${lockfiles.map((l) => code(l.path)).join(', ')} ${lockfiles.length === 1 ? 'was' : 'were'} updated. Install scripts of the new versions run the first time your own CI installs them.`);
  } else if (changedPaths(evidence).some((p) => /(?:^|\/)package\.json$/.test(p))) {
    lines.push('', '`package.json` dependencies changed. Regenerate the lockfile with your package manager, for example `npm install`, and commit it before marking this ready.');
  }
  const typeErrors = (title, text, list) => {
    if (!list?.length) return;
    lines.push('', `### ${title}`, '', text, '');
    for (const e of list.slice(0, 50)) lines.push(`- ${code(`${e.file}:${e.line}`)} ${code(`${e.code} ${e.message}`)}`);
    if (list.length > 50) lines.push(`- and ${list.length - 50} more in the evidence bundle`);
  };
  typeErrors('Type errors added', 'The rewritten text has these errors on lines the rewrite changed, and the original text does not.', evidence.typecheck?.added);
  typeErrors('New type errors on unchanged lines', 'The rewritten files have these errors on lines the rewrite did not change. The upgrade itself often causes them, and an error in the original text, such as an import the new version removed, hid them, so the gate does not count them. Check them before marking this ready.', evidence.typecheck?.otherLines);
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

const testsFailing = (evidence) => Boolean(evidence?.tests && evidence.tests.exitCode !== 0);

// A removed default export, from a d.ts draft: the imports that break, when the new release exports the old default's
// name the import that replaces them, and the manual rule that lists them. Names were checked as identifiers and package
// paths when drafted.
function defaultExportText(d, version) {
  const spec = String(d.import).replace(/[^\w$.@/~-]/g, '');
  const ident = (s) => (/^[A-Za-z_$][\w$]*$/.test(s ?? '') ? s : null);
  const was = ident(d.was);
  const now = ident(d.replacement);
  const local = was ?? 'x';
  const broken = [`import ${local} from '${spec}'`, d.commonjs && `const ${local} = require('${spec}')`].filter(Boolean);
  const fix = now ? ` ${code(version)} exports ${code(now)} by name instead: ${[`import { ${now} } from '${spec}'`, d.commonjs && `const { ${now} } = require('${spec}')`].filter(Boolean).map(code).join(' or ')}.`
    : was ? ` It was ${code(was)}, and ${code(version)} exports nothing by that name, so what replaces it has to be found by hand.` : '';
  const listed = d.rule ? ` The rule ${code(d.rule)} lists each of these imports${d.commonjs ? ' and requires' : ''} in this repository under Unresolved call sites.` : '';
  return `${code(spec)} ${code(version)} has no default export, so ${broken.map(code).join(' and ')} no longer ${broken.length === 1 ? 'works' : 'work'}.${fix}${listed}`;
}

export function watchTitle(entry, evidence = null) {
  const what = `API migration: ${String(entry.package).replace(/[\r\n]/g, '')} ${entry.from} to ${entry.to}`;
  return [testsFailing(evidence) && '[tests failing]', entry.source !== 'signed' && '[unsigned draft]', what].filter(Boolean).join(' ');
}

export function watchBody(entry, evidence, ruleSet, { rulesPath = 'rules.json', runUrl = null } = {}) {
  const at = (u) => `${u.repo}@${u.ref}${u.dir ? ` in ${u.dir}` : ''}`;
  const lines = [];
  if (testsFailing(evidence)) {
    const n = evidence.unresolved.length;
    const where = n ? ` ${n} call ${n === 1 ? 'site was' : 'sites were'} not rewritten and ${n === 1 ? 'is' : 'are'} listed under Unresolved call sites, the first place to look.` : '';
    const log = /^https:\/\/[\w.-]+\/[\w./-]+$/.test(runUrl ?? '') ? ` The test output is in the [workflow run](${runUrl}).` : ' The test output is in the workflow log.';
    lines.push('> [!CAUTION]', `> **Tests failing.** After the migration, ${code(evidence.tests.cmd)} exited with code ${evidence.tests.exitCode}. This pull request was opened anyway so the upgrade is visible. It is not ready: fix the failures or close it.${where}${log}`, '');
  }
  if (entry.source === 'signed') {
    lines.push(`Rules for ${code(entry.package)} ${code(entry.from)} to ${code(entry.to)}, signed by ${code(entry.domain)} with key ${code(entry.keyId)} and fetched from ${code(entry.url)}.`);
  } else {
    const basis = entry.draftedFrom === 'd.ts'
      ? `the TypeScript declarations in the npm tarballs of the two releases, ${cell(`${entry.upstream.from.package}@${entry.upstream.from.version}`)} and ${cell(`${entry.upstream.to.package}@${entry.upstream.to.version}`)}, each checked against its sha512 integrity. Removed functions and methods of the package root, removed default exports and changed required arguments are manual rules, and a rename is drafted only from an @deprecated note that names the replacement`
      : `the api.md files of the two releases, ${cell(at(entry.upstream.from))} and ${cell(at(entry.upstream.to))}`;
    lines.push(
      '> [!WARNING]',
      `> **Unsigned.** No signed rules were found for ${code(entry.package)} ${code(entry.from)} to ${code(entry.to)}, so apimigrate drafted them from ${basis}. Nobody has reviewed these rules, and the provider has not signed them. ${entry.needsReview} of ${entry.ruleCount} are marked needs-review. Read every change before marking this ready.`,
    );
    for (const n of entry.notes ?? []) lines.push('>', `> ${cell(n, 400)}`);
  }
  for (const d of (entry.defaultExportsRemoved ?? []).slice(0, 5)) lines.push('', '> [!IMPORTANT]', `> **Default export removed, needs review.** ${defaultExportText(d, entry.to)}`);
  if (entry.uncovered?.length) {
    lines.push('', '### Not covered by any rule', '', 'These changes were found in the declarations, but no rule can find or rewrite them. The draft report lists them in full.', '');
    for (const u of entry.uncovered.slice(0, 20)) lines.push(`- ${cell(u, 400)}`);
  }
  if (entry.grouped?.length) {
    const n = entry.grouped.reduce((sum, g) => sum + g.count, 0);
    lines.push('', '### Removed without a rule each', '', `These ${n} removals get no rule each. They are static members, or names only in subpaths other than the package root, which applications rarely call. No rule looks for their call sites, so a call to one breaks after the upgrade and is not listed under Unresolved call sites. The draft report lists every one.`, '');
    for (const g of entry.grouped.slice(0, 20)) lines.push(`- ${cell(g.summary, 400)}`);
  }
  if (entry.deprecated) lines.push('', `The latest release is deprecated on npm: ${cell(entry.deprecated, 400)}`);
  const sites = new Map();
  for (const c of [...evidence.callSites, ...evidence.unresolved]) sites.set(c.ruleId, (sites.get(c.ruleId) ?? 0) + 1);
  // Rules with call sites in this repository first, needs-review before the others. The rest keep the rule file's
  // order, which in a draft puts what callers most likely hit first.
  const rank = (r) => (sites.has(r.id) ? 0 : 2) + (r.confidence === 'needs-review' ? 0 : 1);
  const rules = [...(ruleSet.rules ?? [])].sort((a, b) => rank(a) - rank(b));
  lines.push('', entry.source === 'signed' ? '### Rules' : '### Drafted rules', '', '| Rule | Kind | Confidence | Sites here | Evidence |', '| --- | --- | --- | --- | --- |');
  for (const r of rules.slice(0, 100)) lines.push(`| ${cell(r.id, 100)} | ${cell(r.kind)} | ${r.confidence ? cell(r.confidence) : 'signed'} | ${sites.get(r.id) ?? 0} | ${r.evidence ? cell(r.evidence) : ''} |`);
  if (rules.length > 100) lines.push(`| and ${rules.length - 100} more in the uploaded rule file | | | | |`);
  const head = lines.join('\n').slice(0, 20000) + '\n\n';
  return head + prBody(evidence, { rulesPath, limit: MAX_BODY - head.length });
}

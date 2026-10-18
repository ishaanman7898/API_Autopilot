const MAX_BODY = 60000;
const MAX_EVIDENCE = 30000;

// Values come from repo paths and rule text, so they are flattened before they reach markdown.
const code = (s) => '`' + String(s).replace(/[`\r\n]/g, '') + '`';

export const changedPaths = (evidence) => evidence.files.filter((f) => f.after !== null).map((f) => f.path);

export function branchName(evidence, runId) {
  const slug = evidence.rule.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'rule';
  return `apimigrate/${slug}-${String(runId).replace(/[^0-9]/g, '') || '0'}`;
}

export function prBody(evidence, { rulesPath = 'rules.json' } = {}) {
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
    `apimigrate verify --rules ${String(rulesPath).replace(/[`\r\n]/g, '')} --evidence evidence.json --root <base checkout> --head <head checkout> --well-known <provider domain>`,
    '```',
  );
  const json = JSON.stringify(evidence, null, 2);
  const shown = json.length > MAX_EVIDENCE ? json.slice(0, MAX_EVIDENCE) + '\n... truncated, see the uploaded evidence artifact' : json;
  lines.push('', '<details><summary>Evidence bundle</summary>', '', '```json', shown.replace(/```/g, "'''"), '```', '', '</details>');
  return lines.join('\n').slice(0, MAX_BODY) + '\n';
}

#!/usr/bin/env node
// Summarizes a bench/run.mjs results file as markdown: totals, one row per repository, and the
// type errors that remain after migration grouped by kind.  Usage: node bench/report.mjs results.json
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rows = data.results;
const ok = rows.filter((r) => !r.error);
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

// Short labels for the type errors an SDK upgrade typically causes.
function kind(d) {
  const m = d.message;
  if (/Property '(\w+)' does not exist/.test(m)) return `missing property \`${m.match(/Property '(\w+)'/)[1]}\``;
  if (/has no exported member/.test(m)) return 'type no longer exported';
  if (/Cannot find module '@mux/.test(m)) return 'SDK subpath no longer exists';
  if (/Namespace '.*' has no exported member/.test(m)) return 'type moved out of namespace';
  if (/is not assignable|not assignable to parameter/.test(m)) return 'type mismatch';
  return `${d.code}`;
}

const byRule = new Map();
for (const r of ok) for (const [id, n] of Object.entries(r.changedByRule)) byRule.set(id, (byRule.get(id) ?? 0) + n);
const reasons = count(ok.flatMap((r) => r.unresolved.map((u) => u.reason.replace(/ of \S+ /, ' of <call> '))));
const broken = ok.flatMap((r) => r.brokenByUpgrade);
const still = ok.flatMap((r) => r.stillBroken);
const added = ok.flatMap((r) => r.newFromMigration);
const affected = ok.filter((r) => r.brokenByUpgrade.length);

const lines = [
  `Rule file \`${data.rules}\`, old SDK \`${data.oldSdk.join(', ')}\`, new SDK \`${data.newSdk.join(', ')}\`${data.types?.length ? `, also installed \`${data.types.join(', ')}\`` : ''}, run ${data.ranAt.slice(0, 10)}.`,
  '',
  '| | |',
  '| --- | --- |',
  `| Repositories | ${rows.length} |`,
  `| Benchmarked | ${ok.length} (${rows.length - ok.length} skipped: ${[...count(rows.filter((r) => r.error).map((r) => r.error))].map(([e, n]) => `${n} ${e}`).join(', ') || 'none'}) |`,
  `| Sites rewritten (imports and calls) | ${sum(ok, (r) => r.changed)} in ${sum(ok, (r) => r.filesChanged)} files |`,
  ...[...byRule].map(([id, n]) => `| &nbsp;&nbsp;by \`${id}\` | ${n} |`),
  `| Sites queued for a person or agent | ${sum(ok, (r) => r.unresolved.length)} |`,
  `| Gate failures | ${ok.filter((r) => !r.gate).length} |`,
  `| Repos where upgrading breaks the type-check | ${affected.length} of ${ok.length} |`,
  `| Type errors caused by upgrading without migrating | ${broken.length} |`,
  `| ... fixed by apimigrate | ${sum(ok, (r) => r.fixed)} |`,
  `| ... still present after apimigrate | ${still.length} |`,
  `| New type errors introduced by apimigrate | ${added.length} |`,
  `| package.json files updated | ${sum(ok, (r) => r.manifestsChanged?.length ?? 0)} in ${ok.filter((r) => r.manifestsChanged?.length).length} repos |`,
  `| Repos with an SDK import its package.json does not declare | ${ok.filter((r) => r.undeclaredImports?.length).length} of ${ok.length} (${sum(ok, (r) => r.undeclaredImports?.length ?? 0)} files) |`,
  `| Repos where the SDK resolved in the baseline type-check | ${ok.filter((r) => r.sdkResolvedInBaseline).length} of ${ok.length} |`,
  ...(ok.some((r) => r.leftoverImports != null) ? [`| Old package names left in code after migration | ${sum(ok, (r) => r.leftoverImports ?? 0)} files |`] : []),
  `| Median apply time | ${median(ok.map((r) => r.applyMs))} ms |`,
  '',
  '### Per repository',
  '',
  '| Repository | Rewritten | Queued | Upgrade breaks | Still broken | Added by migration |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((r) => r.error
    ? `| [${r.repo}](https://github.com/${r.repo}) | ${r.error} | | | | |`
    : `| [${r.repo}](https://github.com/${r.repo}/tree/${r.commit}) | ${r.changed} | ${r.unresolved.length} | ${r.brokenByUpgrade.length} | ${r.stillBroken.length} | ${r.newFromMigration.length} |`),
  '',
  '### Type errors still present after migration, by kind',
  '',
  ...([...count(still.map(kind))].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`)),
  ...(still.length ? [] : ['- none']),
  '',
  '### Why sites were queued',
  '',
  ...([...reasons].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`)),
  ...(reasons.size ? [] : ['- none']),
];
console.log(lines.join('\n'));

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

import { addedLines, findSecrets } from './secrets.js';
import { matchesAny } from './glob.js';
import { isTestFile, scanTestFile } from './testscan.js';

export { isTestFile };

export const DEFAULT_PROTECTED = [
  '.github/workflows/**', '.gitlab-ci.yml', '.circleci/**', 'azure-pipelines.yml', 'Jenkinsfile', 'codecov.yml', '.codecov.yml',
  '**/jest.config.*', '**/vitest.config.*', '**/karma.conf.*', '**/playwright.config.*', '**/cypress.config.*',
  '**/.mocharc*', '**/ava.config.*', '**/.nycrc*', '**/.c8rc*',
];
const PACKAGE_TEST_KEYS = ['jest', 'vitest', 'c8', 'nyc', 'mocha', 'ava'];
const SCRIPT_KEYS = ['test', 'pretest', 'posttest', 'test:unit', 'coverage'];

const byFinding = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

export function isGateFile(path, protect = DEFAULT_PROTECTED) {
  return isTestFile(path) || path === 'package.json' || matchesAny(path, protect);
}

// Lines that differ between two texts, as the span from the first to the last differing line.
function changedSpan(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  return { first: start + 1, last: Math.max(endY, start + 1) };
}

function packageTestSettings(text) {
  try {
    const pkg = JSON.parse(text);
    const scripts = Object.fromEntries(SCRIPT_KEYS.filter((k) => pkg.scripts?.[k] !== undefined).map((k) => [k, pkg.scripts[k]]));
    return JSON.stringify({ scripts, ...Object.fromEntries(PACKAGE_TEST_KEYS.filter((k) => pkg[k] !== undefined).map((k) => [k, pkg[k]])) });
  } catch {
    return null;
  }
}

function compareTests(file, base, head, findings) {
  const a = scanTestFile(file, base);
  const b = scanTestFile(file, head);
  const add = (code, line, message) => findings.push({ code, file, line, message });
  const fresh = (key) => (b[key].length > a[key].length ? b[key].slice(a[key].length) : []);

  if (b.assertions.length < a.assertions.length) {
    add('assertions-dropped', b.assertions.at(-1) ?? 1, `${file}: assertions dropped from ${a.assertions.length} to ${b.assertions.length}`);
  }
  for (const line of fresh('skips')) add('test-skipped', line, `${file}:${line}: skipped, todo or focused test added`);
  for (const line of fresh('weak')) add('assertion-weakened', line, `${file}:${line}: weak assertion added (truthiness, definedness or anything)`);
  for (const line of fresh('noMatcher')) add('assertion-empty', line, `${file}:${line}: expect() without a matcher`);
  for (const line of fresh('tautologies')) add('assertion-tautology', line, `${file}:${line}: assertion on a literal value`);
  for (const line of fresh('commented')) add('assertion-commented', line, `${file}:${line}: assertion or test commented out`);
}

// Fails on anything an agent could do to make a suite pass without the code being right.
// base and head map path to LF text. coverage values are line percentages or null. allow lists paths exempt from protection.
export function runGate({ base, head, protect = DEFAULT_PROTECTED, allow = [], coverageBase = null, coverageHead = null, coverageTolerance = 0 }) {
  const findings = [];
  const add = (code, file, line, message) => findings.push({ code, file, line, message });
  let before = 0;
  let after = 0;

  for (const file of Object.keys(base)) {
    if (!isTestFile(file)) continue;
    before += scanTestFile(file, base[file]).assertions.length;
    if (!(file in head)) add('test-removed', file, 1, `${file}: test file removed`);
  }
  for (const file of Object.keys(head)) {
    if (!isTestFile(file)) continue;
    after += scanTestFile(file, head[file]).assertions.length;
    if (file in base && base[file] !== head[file]) compareTests(file, base[file], head[file], findings);
  }
  if (after < before) add('assertions-dropped-total', '', 0, `total assertions dropped from ${before} to ${after}`);

  const guarded = (file) => !allow.includes(file) && !isTestFile(file) && (file === 'package.json' || matchesAny(file, protect));
  for (const file of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (!guarded(file) || base[file] === head[file]) continue;
    if (file === 'package.json' && base[file] && head[file]) {
      const x = packageTestSettings(base[file]);
      const y = packageTestSettings(head[file]);
      if (x !== null && x === y) continue;
      add('protected-changed', file, 1, `${file}: test scripts or test config in package.json changed`);
    } else if (!(file in head)) add('protected-changed', file, 1, `${file}: protected test or CI file removed`);
    else if (!(file in base)) add('protected-changed', file, 1, `${file}: protected test or CI file added`);
    else {
      const { first, last } = changedSpan(base[file], head[file]);
      add('protected-changed', file, first, `${file}:${first}${last > first ? `-${last}` : ''}: protected test or CI file changed`);
    }
  }

  let delta = null;
  if (coverageBase != null && coverageHead == null) add('coverage-missing', '', 0, 'coverage data is missing for the migrated tree');
  else if (coverageBase != null && coverageHead != null) {
    delta = +(coverageHead - coverageBase).toFixed(2);
    if (delta < -coverageTolerance) add('coverage-dropped', '', 0, `line coverage dropped from ${coverageBase}% to ${coverageHead}%`);
  }

  for (const [file, text] of Object.entries(head)) {
    if (base[file] === text) continue;
    const added = addedLines(base[file] ?? '', text);
    const hits = findSecrets(added.map((l) => l.text).join('\n'));
    for (const h of hits) add('secret-added', file, added[h.line - 1].line, `${file}:${added[h.line - 1].line}: added line looks like a ${h.kind}`);
  }

  findings.sort(byFinding);
  return {
    ok: findings.length === 0,
    findings,
    failures: findings.map((f) => f.message),
    assertions: { before, after },
    coverage: { before: coverageBase, after: coverageHead, delta },
  };
}

export const linePct = (summary) => summary?.total?.lines?.pct ?? null;

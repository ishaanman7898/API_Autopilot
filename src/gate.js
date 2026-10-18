import { scanSecrets } from './sanitize.js';

const TEST_FILE = /(?:\.|\/)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;
const ASSERTION = /\b(?:expect|assert)\w*\s*[.(]|\.should\b|\bt\.(?:is|true|false|deepEqual|equal|throws)\b/g;

export const isTestFile = (path) => TEST_FILE.test(path.replaceAll('\\', '/'));
export const countAssertions = (text) => (text.match(ASSERTION) ?? []).length;

function totalAssertions(files) {
  return Object.entries(files).filter(([p]) => isTestFile(p)).reduce((n, [, t]) => n + countAssertions(t), 0);
}

function addedLines(base, head) {
  const added = [];
  for (const [path, text] of Object.entries(head)) {
    const old = new Set((base[path] ?? '').split('\n'));
    for (const line of text.split('\n')) if (!old.has(line)) added.push(line);
  }
  return added.join('\n');
}

// An agent that deletes assertions to turn the suite green must not pass: fail on any assertion or coverage drop.
// base/head: { path: contents }. coverage: line percent from an istanbul coverage-summary.json, or null.
export function runGate({ base, head, coverageBase = null, coverageHead = null, coverageTolerance = 0 }) {
  const failures = [];
  const before = totalAssertions(base);
  const after = totalAssertions(head);
  if (after < before) failures.push(`assertions dropped from ${before} to ${after}`);

  for (const path of Object.keys(base)) {
    if (isTestFile(path) && !(path in head)) failures.push(`test file removed: ${path}`);
  }

  let delta = null;
  if (coverageBase != null && coverageHead != null) {
    delta = +(coverageHead - coverageBase).toFixed(2);
    if (delta < -coverageTolerance) failures.push(`line coverage dropped ${coverageBase}% -> ${coverageHead}%`);
  }

  const secrets = scanSecrets(addedLines(base, head));
  if (secrets.length) failures.push(`diff adds secrets: ${secrets.join(', ')}`);

  return { ok: failures.length === 0, failures, assertions: { before, after }, coverage: { before: coverageBase, after: coverageHead, delta } };
}

export const linePct = (summary) => summary?.total?.lines?.pct ?? null;

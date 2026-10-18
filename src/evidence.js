import { createHash } from 'node:crypto';
import { applyRuleSet } from './engine.js';
import { canonical, hashRuleSet } from './rule.js';

export const EVIDENCE_SCHEMA = 'apimigrate-evidence/2';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const bySite = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.ruleId < b.ruleId ? -1 : 1));

// Digests of every file whose text changed. Inputs are LF-normalized, so the result does not depend on the OS.
export function fileDigests(before, after) {
  const changed = Object.keys(after)
    .filter((p) => before[p] !== after[p])
    .map((path) => ({ path, before: sha(before[path] ?? ''), after: sha(after[path]) }));
  const removed = Object.keys(before).filter((p) => !(p in after)).map((path) => ({ path, before: sha(before[path]), after: null }));
  return [...changed, ...removed].sort(byPath);
}

export const replayDigestOf = (ruleSet, files) => sha(canonical({ rule: hashRuleSet(ruleSet), files }));

// Everything except meta is a pure function of the rule, the base tree and any agent edits.
export function buildEvidence({ ruleSet, before, deterministic, final = deterministic.files, gate, tests = null, install = null, agent = null, tool, scan, now = new Date() }) {
  const detFiles = fileDigests(before, deterministic.files);
  return {
    schema: EVIDENCE_SCHEMA,
    rule: {
      id: ruleSet.id,
      provider: ruleSet.provider,
      contentHash: hashRuleSet(ruleSet),
      signed: Boolean(ruleSet.signature),
      keyId: ruleSet.signature?.keyId ?? null,
    },
    tool,
    scan,
    callSites: [...deterministic.changes].sort(bySite),
    unresolved: deterministic.unresolved.map(({ file, line, ruleId, reason }) => ({ file, line, ruleId, reason })).sort(bySite),
    skipped: [...deterministic.skipped].sort((a, b) => (a.file < b.file ? -1 : 1)),
    deterministic: { files: detFiles, replayDigest: replayDigestOf(ruleSet, detFiles) },
    files: fileDigests(before, final),
    agent,
    gate,
    tests,
    install,
    meta: { createdAt: now.toISOString() },
  };
}

// Re-runs the deterministic pass on a checkout of the base commit and compares digests with the bundle.
// configs are the base checkout's project config files, so path aliases resolve as they did in the run.
export function replay(ruleSet, baseFiles, evidence, configs = {}) {
  if (evidence.schema !== EVIDENCE_SCHEMA) return { ok: false, reason: `unsupported evidence schema ${evidence.schema}` };
  if (hashRuleSet(ruleSet) !== evidence.rule.contentHash) return { ok: false, reason: 'rule file differs from the one the evidence was built with' };
  const result = applyRuleSet(ruleSet, baseFiles, configs);
  const files = fileDigests(baseFiles, result.files);
  const digest = replayDigestOf(ruleSet, files);
  if (digest !== evidence.deterministic.replayDigest) {
    const expected = new Map(evidence.deterministic.files.map((f) => [f.path, f]));
    const drift = files.filter((f) => expected.get(f.path)?.after !== f.after).map((f) => f.path);
    for (const f of expected.keys()) if (!files.some((x) => x.path === f)) drift.push(f);
    return { ok: false, reason: 'replay digest differs', digest, expected: evidence.deterministic.replayDigest, drift: [...new Set(drift)].sort() };
  }
  return { ok: true, digest };
}

// Checks a head tree against the final digests recorded in the bundle, including any agent edits.
// Lockfiles the install changed are checked too when they are among the scanned files.
export function checkHead(baseFiles, headFiles, evidence) {
  const actual = fileDigests(baseFiles, headFiles);
  const lockfiles = (evidence.install?.lockfiles ?? []).filter((l) => l.path in baseFiles || l.path in headFiles);
  const expected = [...evidence.files, ...lockfiles];
  const want = new Map(expected.map((f) => [f.path, f.after]));
  const got = new Map(actual.map((f) => [f.path, f.after]));
  const drift = [...new Set([...want.keys(), ...got.keys()])].filter((p) => want.get(p) !== got.get(p)).sort();
  return drift.length ? { ok: false, reason: 'head tree differs from the evidence', drift } : { ok: true };
}

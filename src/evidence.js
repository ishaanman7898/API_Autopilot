import { createHash } from 'node:crypto';
import { applyRuleSet } from './engine.js';
import { canonical } from './rule.js';

const sha = (text) => createHash('sha256').update(text).digest('hex');

// Per-file before/after digests: enough for a reviewer to replay the migration and compare byte for byte.
export function fileDigests(before, after) {
  return Object.keys(after)
    .filter((p) => before[p] !== after[p])
    .sort()
    .map((path) => ({ path, before: sha(before[path] ?? ''), after: sha(after[path]) }));
}

export function buildEvidence({ ruleSet, before, result, gate, tests = null }) {
  const files = fileDigests(before, result.files);
  return {
    schema: 'apimigrate-evidence/1',
    createdAt: new Date().toISOString(),
    rule: {
      id: ruleSet.id,
      provider: ruleSet.provider,
      hash: ruleSet.signature?.hash ?? null,
      keyId: ruleSet.signature?.keyId ?? null,
      signed: Boolean(ruleSet.signature),
    },
    callSites: result.changes,
    unresolved: result.unresolved.map(({ file, line, ruleId }) => ({ file, line, ruleId })),
    files,
    replayDigest: sha(canonical(files)),
    gate,
    tests,
  };
}

// Re-run the deterministic pass on a checkout of the PR's base commit and compare digests to the evidence bundle.
export function replay(ruleSet, baseFiles, evidence) {
  const result = applyRuleSet(ruleSet, baseFiles);
  const digest = sha(canonical(fileDigests(baseFiles, result.files)));
  const expected = evidence.replayDigest;
  return {
    ok: digest === expected && (ruleSet.signature?.hash ?? null) === evidence.rule.hash,
    digest,
    expected,
    note: evidence.unresolved.length ? 'unresolved call sites were handled by an agent; only the deterministic pass is replayed' : undefined,
  };
}

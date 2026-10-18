const PATTERNS = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['stripe-key', /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

// Returns { kind, line } for each hit. Values are never returned.
export function findSecrets(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [kind, re] of PATTERNS) if (re.test(line)) hits.push({ kind, line: i + 1 });
  });
  return hits;
}

// Lines present in head but not in base, with their head line numbers.
export function addedLines(base, head) {
  const seen = new Map();
  for (const l of base.split('\n')) seen.set(l, (seen.get(l) ?? 0) + 1);
  const added = [];
  head.split('\n').forEach((l, i) => {
    const n = seen.get(l) ?? 0;
    if (n > 0) seen.set(l, n - 1);
    else added.push({ text: l, line: i + 1 });
  });
  return added;
}

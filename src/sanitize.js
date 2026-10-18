// Repo text, changelogs and specs are untrusted: they can carry prompt injection into the fallback agent.
const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i,
  /disregard (the )?(system|previous) (prompt|instructions)/i,
  /you are now\b/i,
  /\bsystem prompt\b/i,
  /(exfiltrate|send|post|upload) .{0,40}(secret|token|credential|api[_ -]?key|\.env)/i,
  /curl\s+[^\n|]*\|\s*(sh|bash)/i,
];

const SECRETS = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
];

export function scanUntrusted(text) {
  return INJECTION.filter((re) => re.test(text)).map((re) => re.source);
}

export function scanSecrets(text) {
  return SECRETS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// Fence untrusted text so an agent sees it as data, and never lets it close the fence.
export function fence(text) {
  return '<untrusted_repo_text>\n' + text.replaceAll('</untrusted_repo_text>', '') + '\n</untrusted_repo_text>';
}

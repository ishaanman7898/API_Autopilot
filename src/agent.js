import { LIMITS, fence, sanitize } from './sanitize.js';

const MAX_FILE_BYTES = 1024 * 1024;

// The task text comes from the signed rule and is trusted. The code context is not.
export function buildQueue(unresolved, ruleSet) {
  const promptFor = (id) => ruleSet.rules.find((r) => r.id === id)?.fallback?.prompt ?? `Migrate this call site (${id}) to ${ruleSet.provider} ${ruleSet.to}.`;
  let total = 0;
  const items = [];
  let overflow = 0;
  unresolved.forEach((u, i) => {
    const clean = sanitize(u.snippet ?? '');
    const size = Buffer.byteLength(clean.text);
    if (items.length >= LIMITS.sites || total + size > LIMITS.totalBytes) { overflow++; return; }
    total += size;
    items.push({
      id: `${u.ruleId}#${i + 1}`,
      file: u.file,
      line: u.line,
      ruleId: u.ruleId,
      reason: u.reason,
      task: promptFor(u.ruleId),
      context: fence(clean.text),
      removedLines: clean.removed,
      truncated: clean.truncated,
    });
  });
  return { schema: 'apimigrate-queue/1', rule: ruleSet.id, items, overflow };
}

// Agent output is a map of path to full new contents. It may only touch files that have queued sites.
export function applyAgentResult(result, queue, files) {
  const errors = [];
  const allowed = new Set(queue.items.map((i) => i.file));
  const next = { ...files };
  const touched = [];
  if (!result || typeof result.files !== 'object' || result.files === null || Array.isArray(result.files)) {
    return { ok: false, errors: ['agent result must be { "files": { path: content } }'], files, touched };
  }
  for (const [file, content] of Object.entries(result.files)) {
    if (!allowed.has(file)) errors.push(`${file}: not a file with an unresolved call site`);
    else if (typeof content !== 'string') errors.push(`${file}: content must be a string`);
    else if (Buffer.byteLength(content) > MAX_FILE_BYTES) errors.push(`${file}: larger than ${MAX_FILE_BYTES} bytes`);
    else if (!(file in files)) errors.push(`${file}: not in the scanned tree`);
    else {
      next[file] = content.replace(/\r\n/g, '\n');
      if (next[file] !== files[file]) touched.push(file);
    }
  }
  return errors.length ? { ok: false, errors, files, touched: [] } : { ok: true, errors, files: next, touched: touched.sort() };
}

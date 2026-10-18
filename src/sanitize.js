// Repo text, comments, changelogs and specs are untrusted. Before any of it reaches a model it is
// cleaned, bounded and fenced. Stripping instruction-like lines is a heuristic and not a guarantee.
const INSTRUCTION = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|any|system|these)\b.{0,30}\b(instructions?|prompts?|rules?|messages?)\b/i,
  /\byou are (now|no longer)\b/i,
  /\b(new|updated|real) (instructions?|task|rules?)\b\s*[:\-]/i,
  /\b(system|developer) (prompt|message)\b/i,
  /^\s*(?:\/\/|#|\*|\/\*)?\s*(system|assistant|user|human)\s*:/i,
  /<\|?(im_start|im_end|system|endoftext)\|?>/i,
  /\b(act|behave|respond) as\b/i,
  /\bdo not (tell|inform|mention|reveal)\b/i,
  /\b(exfiltrate|send|post|upload|email|leak|print|reveal)\b.{0,50}\b(secrets?|tokens?|credentials?|passwords?|api[ _-]?keys?|\.env|ssh)\b/i,
  /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
  /\b(run|execute|eval)\b.{0,20}\b(this|the following) (command|script|code)\b/i,
];

const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const FENCE_TAG = /<\/?\s*untrusted_repo_text[^>]*>/gi;

export const LIMITS = { lineChars: 240, siteBytes: 2000, totalBytes: 100_000, sites: 200 };

export function scanUntrusted(text) {
  return text.split('\n').filter((l) => INSTRUCTION.some((re) => re.test(l))).map((l) => l.trim().slice(0, 80));
}

// Returns the cleaned text plus a record of what was removed, by line, without echoing the removed text.
export function sanitize(text) {
  const removed = [];
  const lines = text
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(FENCE_TAG, '')
    .split('\n')
    .map((line, i) => {
      if (INSTRUCTION.some((re) => re.test(line))) {
        removed.push({ line: i + 1, reason: 'looks like an instruction to a model' });
        return '[line removed: looks like an instruction to a model]';
      }
      return line.length > LIMITS.lineChars ? line.slice(0, LIMITS.lineChars) + ' [truncated]' : line;
    });
  let out = lines.join('\n');
  let truncated = false;
  if (Buffer.byteLength(out) > LIMITS.siteBytes) {
    out = Buffer.from(out).subarray(0, LIMITS.siteBytes).toString('utf8').replace(/�$/, '') + '\n[truncated]';
    truncated = true;
  }
  return { text: out, removed, truncated };
}

// The fence tells the model this is data. Content cannot close it because the tag is stripped first.
export function fence(text) {
  return '<untrusted_repo_text>\n' + text.replace(FENCE_TAG, '') + '\n</untrusted_repo_text>';
}

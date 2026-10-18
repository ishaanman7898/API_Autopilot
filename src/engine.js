import { fence, scanUntrusted } from './sanitize.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function callRegex(call, tail = '') {
  if (call.includes('.')) {
    const body = call.split('.').map(esc).join('\\s*\\.\\s*');
    return new RegExp('\\.' + body + tail, 'g');
  }
  return new RegExp('(?<![\\w$.])' + esc(call) + tail, 'g');
}

// index of the ")" that closes the "(" at `open`, skipping string literals
function closeParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function importsPackage(text, names) {
  return names.some((n) =>
    new RegExp('(?:from\\s+|require\\(\\s*|import\\s+)[\'"]' + esc(n) + '(?:/[^\'"]*)?[\'"]').test(text));
}

function unresolved(file, text, idx, rule, call) {
  const lines = text.split('\n');
  const line = lineOf(text, idx);
  const context = lines.slice(Math.max(0, line - 3), line + 2).join('\n');
  return {
    file, line, ruleId: rule.id, call,
    prompt: rule.fallback?.prompt ?? `Migrate this call site: ${rule.id}`,
    context: fence(context),
    injectionFindings: scanUntrusted(context),
  };
}

// Deterministic pass. Anything a transform cannot prove it handled is returned in `unresolved` for the agent.
export function applyRuleSet(rs, files) {
  const out = { ...files };
  const changes = [];
  const todo = [];
  const names = [rs.package, ...rs.rules.filter((r) => r.kind === 'rename-import').map((r) => r.transform.to)];

  for (const [file, original] of Object.entries(files)) {
    if (rs.scope !== 'any' && !importsPackage(original, names)) continue;
    let text = original;

    for (const rule of rs.rules) {
      if (rule.kind === 'rename-import') {
        const re = new RegExp('([\'"])' + esc(rule.match.module) + '(/[^\'"]*)?\\1', 'g');
        const snapshot = text;
        text = snapshot.replace(re, (m, q, sub = '', off) => {
          changes.push({ file, line: lineOf(snapshot, off), ruleId: rule.id });
          return q + rule.transform.to + sub + q;
        });
      } else if (rule.kind === 'rename-method') {
        const snapshot = text;
        text = snapshot.replace(callRegex(rule.match.call, '(?=\\s*\\()'), (m, off) => {
          changes.push({ file, line: lineOf(snapshot, off), ruleId: rule.id });
          return (m.startsWith('.') ? '.' : '') + rule.transform.to;
        });
      } else if (rule.kind === 'rename-param') {
        const { call, param } = rule.match;
        const to = rule.transform.to;
        const re = callRegex(call, '\\s*\\(');
        const edits = [];
        let m;
        while ((m = re.exec(text))) {
          const open = m.index + m[0].length - 1;
          const close = closeParen(text, open);
          if (close < 0) continue;
          const args = text.slice(open + 1, close);
          const keyed = new RegExp('([{,]\\s*)' + esc(param) + '(\\s*:)', 'g');
          const short = new RegExp('([{,]\\s*)' + esc(param) + '(\\s*[,}])', 'g');
          const next = args
            .replace(keyed, (_, a, b) => a + to + b)
            .replace(short, (_, a, b) => a + to + ': ' + param + b);
          if (next !== args) edits.push({ from: open + 1, to: close, next, line: lineOf(text, m.index) });
          else if (args.trim() && !args.trimStart().startsWith('{')) todo.push(unresolved(file, text, m.index, rule, call));
        }
        for (const e of edits.reverse()) {
          text = text.slice(0, e.from) + e.next + text.slice(e.to);
          changes.push({ file, line: e.line, ruleId: rule.id });
        }
      } else if (rule.kind === 'replace') {
        if (rule.match.files && !rule.match.files.some((f) => file.endsWith(f))) continue;
        const snapshot = text;
        text = snapshot.replace(new RegExp(rule.match.pattern, rule.match.flags ?? 'g'), (m, ...rest) => {
          const off = rest.find((x) => typeof x === 'number');
          changes.push({ file, line: lineOf(snapshot, off), ruleId: rule.id });
          return m.replace(new RegExp(rule.match.pattern, rule.match.flags?.replace('g', '') ?? ''), rule.transform.to);
        });
      } else if (rule.kind === 'manual') {
        const re = callRegex(rule.match.call, '(?=\\s*\\()');
        let m;
        while ((m = re.exec(text))) todo.push(unresolved(file, text, m.index, rule, rule.match.call));
      }
    }
    out[file] = text;
  }
  return { files: out, changes, unresolved: todo };
}

const MAX_CELLS = 4_000_000;

// Edit script of two line arrays by longest common subsequence, as [op, text, old line, new line].
function editScript(a, b) {
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([' ', a[i], i + 1, j + 1]); i++; j++; }
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push(['-', a[i], i + 1, j + 1]); i++; }
    else { ops.push(['+', b[j], i + 1, j + 1]); j++; }
  }
  return ops;
}

// Changed line ranges between two texts, as { oldStart, oldEnd, newStart, newEnd } with 1-based lines and
// exclusive ends. Common first and last lines are trimmed before the diff. When the rest is too large for it,
// the whole rest is one range.
export function lineHunks(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const x = a.slice(p, a.length - s);
  const y = b.slice(p, b.length - s);
  if (!x.length && !y.length) return [];
  if (x.length * y.length > MAX_CELLS) return [{ oldStart: p + 1, oldEnd: p + 1 + x.length, newStart: p + 1, newEnd: p + 1 + y.length }];
  const hunks = [];
  let open = null;
  for (const [t, , i, j] of editScript(x, y)) {
    if (t === ' ') { open = null; continue; }
    if (!open) hunks.push(open = { oldStart: p + i, oldEnd: p + i, newStart: p + j, newEnd: p + j });
    if (t === '-') open.oldEnd++;
    else open.newEnd++;
  }
  return hunks;
}

// Line diff by longest common subsequence, printed as unified hunks. Large files get a summary line instead.
export function unifiedDiff(path, before, after, context = 2) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_CELLS) return `--- a/${path}\n+++ b/${path}\n(diff too large to print, ${a.length} to ${b.length} lines)\n`;
  const ops = editScript(a, b);
  const keep = ops.map(([t], k) => t !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some(([u]) => u !== ' '));
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) { k++; continue; }
    let end = k;
    while (end < ops.length && keep[end]) end++;
    const hunk = ops.slice(k, end);
    const oldN = hunk.filter(([t]) => t !== '+').length;
    const newN = hunk.filter(([t]) => t !== '-').length;
    lines.push(`@@ -${hunk[0][2]},${oldN} +${hunk[0][3]},${newN} @@`);
    for (const [t, text] of hunk) lines.push(t + text);
    k = end;
  }
  return lines.join('\n') + '\n';
}

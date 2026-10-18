const MAX_CELLS = 4_000_000;

// Line diff by longest common subsequence, printed as unified hunks. Large files get a summary line instead.
export function unifiedDiff(path, before, after, context = 2) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_CELLS) return `--- a/${path}\n+++ b/${path}\n(diff too large to print, ${a.length} to ${b.length} lines)\n`;
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

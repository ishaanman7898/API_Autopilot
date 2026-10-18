import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.apimigrate']);
const DEFAULT_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
const MAX_BYTES = 2 * 1024 * 1024;

const posix = (p) => p.split(sep).join('/');

// Text is held as LF without a BOM so digests match across operating systems. The original style is kept for writing back.
export function normalize(raw) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  return { text: body.replace(/\r\n/g, '\n'), style: { eol: crlf > lf ? '\r\n' : '\n', bom } };
}

export const denormalize = (text, style) => (style.bom ? '﻿' : '') + (style.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

// Reads files under paths in sorted order. Paths may not leave root and symbolic links are never followed.
export function readTree(root, { paths = ['.'], extensions = [] } = {}) {
  const base = resolve(root);
  const wanted = extensions.length ? extensions : DEFAULT_EXT;
  const files = {};
  const styles = {};
  const skipped = [];

  const take = (full) => {
    const rel = posix(relative(base, full));
    if (statSync(full).size > MAX_BYTES) return skipped.push({ file: rel, reason: 'larger than 2 MB, not scanned' });
    const { text, style } = normalize(readFileSync(full, 'utf8'));
    files[rel] = text;
    styles[rel] = style;
  };
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && wanted.some((x) => e.name.endsWith(x))) take(full);
    }
  };

  for (const p of paths) {
    const full = resolve(base, p);
    if (full !== base && !full.startsWith(base + sep)) throw new Error(`path ${p} is outside the repository root`);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full);
    else if (st.isFile()) take(full);
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { files: sorted, styles, skipped };
}

export function writeChanged(root, before, after, styles) {
  const base = resolve(root);
  const written = [];
  for (const [file, text] of Object.entries(after)) {
    if (before[file] === text) continue;
    const full = resolve(base, file);
    if (!full.startsWith(base + sep)) throw new Error(`refusing to write outside the repository root: ${file}`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, denormalize(text, styles[file] ?? { eol: '\n', bom: false }));
    written.push(file);
  }
  return written;
}

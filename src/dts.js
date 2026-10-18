import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
import { fetchBytes } from './net.js';
import { buildProgram } from './parse.js';
import { SCHEMA } from './rule.js';

// Packages without api.md files still publish TypeScript declarations in their npm tarball. This reads the
// declarations of two releases and drafts conservative rules from what was removed or changed. Each tarball is
// checked against the sha512 integrity npm recorded before it is read, and it is unpacked in memory only.
// Nothing in it is installed, run or written to disk.

export const LIMITS = { tarball: 32 * 1024 * 1024, unpacked: 256 * 1024 * 1024, files: 5000, bytes: 48 * 1024 * 1024 };
const KEEP = /(?:\.d\.[cm]?ts|(?:^|\/)package\.json)$/;
const DECL = /\.d\.[cm]?ts$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const NPM_NAME = /^(?:@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*$/;
const SUBPATH = /^\.\/[\w.@/-]*$/;
// Members every object or function has. Without the standard library they are missing from some declarations.
const BUILTIN = new Set(['toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'constructor', 'apply', 'call', 'bind']);
const BLOCK = 512;

const field = (buf, start, end) => {
  const s = buf.subarray(start, end);
  const nul = s.indexOf(0);
  return (nul === -1 ? s : s.subarray(0, nul)).toString('utf8');
};
// Sizes in base-256, which only files over 8 GB need, are refused along with anything else that is not octal.
const octal = (buf, start, end) => {
  const text = field(buf, start, end).trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null;
};
function checksumOk(h) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return octal(h, 148, 156) === sum;
}
// pax records are "<length> <key>=<value>\n", the length counting the whole record.
function paxRecords(data) {
  const out = {};
  for (let pos = 0; pos < data.length;) {
    const sp = data.indexOf(0x20, pos);
    const len = sp === -1 ? NaN : Number(data.subarray(pos, sp).toString());
    if (!Number.isInteger(len) || len <= sp - pos || pos + len > data.length) break;
    const record = data.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

// Regular files of a ustar archive, with pax and GNU long names. Links, devices and directories are skipped and
// never followed. npm puts everything under one top directory, usually package/, which is removed from each path.
// A name that is absolute or has a .. segment rejects the whole archive. keep(path) picks the files that are read.
export function readTar(tar, { keep = () => true, maxFiles = LIMITS.files, maxBytes = LIMITS.bytes } = {}) {
  const files = new Map();
  let bytes = 0;
  let pax = {};
  let longName = null;
  for (let pos = 0; pos + BLOCK <= tar.length;) {
    const h = tar.subarray(pos, pos + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw new Error(`tarball header at byte ${pos} has a bad checksum`);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const size = pax.size !== undefined ? Number(pax.size) : octal(h, 124, 136);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tarball entry at byte ${pos} has an unreadable size`);
    const start = pos + BLOCK;
    if (start + size > tar.length) throw new Error('tarball is truncated');
    const data = tar.subarray(start, start + size);
    pos = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { pax = paxRecords(data); continue; }
    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    if (type === 'g' || type === 'K') continue;
    const prefix = field(h, 257, 263) === 'ustar' ? field(h, 345, 500) : '';
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    pax = {};
    longName = null;
    if (/^[\\/]|^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')) throw new Error(`tarball entry ${JSON.stringify(name.slice(0, 200))} points outside the package`);
    if (type !== '0' && type !== '7') continue;
    const rel = name.split('/').filter((s) => s && s !== '.').slice(1).join('/');
    if (!rel || !keep(rel)) continue;
    if (!files.has(rel) && files.size >= maxFiles) throw new Error(`tarball has more than ${maxFiles} files to read`);
    bytes += size;
    if (bytes > maxBytes) throw new Error(`files to read in the tarball are larger than ${maxBytes} bytes`);
    files.set(rel, data.toString('utf8'));
  }
  return files;
}

// Declaration files and package.json files of a gzipped npm tarball.
export function unpackTarball(tgz, limits = {}) {
  const { unpacked, files, bytes } = { ...LIMITS, ...limits };
  let tar;
  try { tar = gunzipSync(tgz, { maxOutputLength: unpacked }); } catch (e) {
    throw new Error(e.code === 'ERR_BUFFER_TOO_LARGE' ? `tarball unpacks to more than ${unpacked} bytes` : `tarball is not gzip: ${e.message}`);
  }
  return readTar(tar, { keep: (p) => KEEP.test(p), maxFiles: files, maxBytes: bytes });
}

// The sha512 entry of a subresource integrity string such as "sha512-<base64>", which npm records for every tarball.
export function integrityError(buf, integrity) {
  const want = String(integrity ?? '').split(/\s+/).find((s) => s.startsWith('sha512-'))?.slice(7).replace(/\?.*$/, '');
  if (!want) return 'has no sha512 integrity in the registry';
  return createHash('sha512').update(buf).digest('base64') === want ? null : 'does not match the sha512 integrity in the registry';
}

// The files of one release, from the tarball its registry manifest names. The tarball must be on the registry's
// host and match the manifest's sha512 integrity before anything in it is read.
export async function releaseFiles(manifest, { registry, fetchImpl, limits = {} }) {
  const lim = { ...LIMITS, ...limits };
  const id = `${manifest.name}@${manifest.version}`;
  const url = manifest.dist?.tarball;
  if (typeof url !== 'string') throw new Error(`${id} has no tarball in the registry`);
  const host = new URL(registry).host;
  let at;
  try { at = new URL(url).host; } catch { at = null; }
  if (at !== host) throw new Error(`the tarball of ${id} is not on ${host}`);
  const tgz = await fetchBytes(url, { fetchImpl, maxBytes: lim.tarball, timeoutMs: 60000, sameHostRedirects: 3 });
  const bad = integrityError(tgz, manifest.dist.integrity);
  if (bad) throw new Error(`the tarball of ${id} ${bad}`);
  return { url, integrity: manifest.dist.integrity.split(/\s+/).find((s) => s.startsWith('sha512-')), files: unpackTarball(tgz, lim) };
}

// Subpaths a consumer can import, from package.json exports. A string or a conditions object is the root only,
// and without exports only the root is read, through types, typings or main as TypeScript would.
function subpathsOf(pkg) {
  const ex = pkg.exports;
  if (ex === undefined || ex === null) return null;
  if (typeof ex !== 'object' || Array.isArray(ex) || !Object.keys(ex).some((k) => k.startsWith('.'))) return ['.'];
  return Object.keys(ex).filter((k) => k.startsWith('.') && ex[k] !== null);
}

const RESOLVE = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, noLib: true, customConditions: ['node', 'require'] };
const arityText = (a) => (a.rest ? `${a.min} or more` : a.min === a.max ? `${a.min}` : `${a.min} to ${a.max}`);
// A call that passed only the required arguments no longer type-checks. Dropped optional arguments are only reported.
const requiredChanged = (o, n) => !o.rest && !n.rest && (n.min > o.min || n.max < o.min);
const optionalDropped = (o, n) => !o.rest && !n.rest && n.max < o.max;
const accepts = (o, n) => !n.unknown && (n.rest ? n.min <= o.min : !o.rest && n.min <= o.min && n.max >= o.max);

// The surface of one release, from its files as unpackTarball returns them. For each subpath a consumer can import:
// its exports, whether each is a value, how many arguments it takes when it is a function, its @deprecated note,
// and the callable static members of values. For classes and interfaces, the methods of an instance.
// Names starting with _ and private or protected members are left out.
export function declarationSurface(files, name) {
  if (!NPM_NAME.test(name)) throw new Error(`${name} is not an npm package name`);
  let pkg = {};
  try { pkg = JSON.parse(files.get('package.json') ?? '{}'); } catch { /* resolved as a package without exports */ }
  const base = `node_modules/${name}`;
  const texts = Object.fromEntries([...files].map(([p, t]) => [`${base}/${p}`, t]));
  const decls = [...files.keys()].filter((p) => DECL.test(p));
  const subpaths = subpathsOf(pkg);
  const surface = { name, version: pkg.version ?? null, files: decls.length, subpaths, entries: new Map(), unresolved: [] };
  if (!decls.length) return surface;

  const { program, checker } = buildProgram(texts);
  const host = { fileExists: (f) => f.slice(1) in texts, readFile: (f) => texts[f.slice(1)] };
  const resolve = (s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const deprecation = (sym) => {
    for (const d of sym?.declarations ?? []) {
      for (const tag of ts.getJSDocTags(d)) if (tag.tagName.text === 'deprecated') return (ts.getTextOfJSDocComment(tag.comment) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    return null;
  };
  const arityOf = (type) => {
    const sigs = type?.getCallSignatures() ?? [];
    if (!sigs.length) return null;
    let min = Infinity;
    let max = 0;
    let rest = false;
    for (const sig of sigs) {
      const decl = sig.getDeclaration();
      // Without a declaration the counts are unknown. Treated as a rest parameter, nothing is compared.
      if (!decl?.parameters) return { min: 0, max: 0, rest: true, unknown: true };
      const params = decl.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
      min = Math.min(min, params.filter((p) => !p.questionToken && !p.initializer && !p.dotDotDotToken).length);
      max = Math.max(max, params.length);
      rest ||= params.some((p) => p.dotDotDotToken);
    }
    return { min, max, rest };
  };
  const isPublic = (sym) => !(sym.declarations ?? []).some((d) => ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
  const callables = (props) => {
    const out = new Map();
    for (const p of props) {
      if (!IDENT.test(p.name) || p.name.startsWith('_') || p.name === 'prototype' || BUILTIN.has(p.name) || !isPublic(p)) continue;
      let arity = null;
      try { arity = arityOf(checker.getTypeOfSymbol(p)); } catch { /* left out */ }
      if (arity) out.set(p.name, { arity, deprecated: deprecation(p) });
    }
    return out;
  };

  for (const sub of subpaths ?? ['.']) {
    if (sub.includes('*') || sub.endsWith('.json')) continue;
    const spec = sub === '.' ? name : `${name}/${sub.slice(2)}`;
    const found = ts.resolveModuleName(spec, '/index.ts', RESOLVE, host).resolvedModule?.resolvedFileName;
    const sf = found && DECL.test(found) ? program.getSourceFile(found) : null;
    const mod = (sf && checker.getSymbolAtLocation(sf)) ?? checker.getAmbientModules().find((m) => m.name === JSON.stringify(spec));
    if (!mod) { surface.unresolved.push(sub); continue; }
    const list = checker.getExportsOfModule(mod).map((s) => [s.name, s]);
    const assigned = mod.exports?.get('export=');
    if (assigned) list.push(['default', assigned]);
    const targets = new Set(list.map(([, s]) => resolve(s)));
    const exports = new Map();
    const classes = new Map();
    for (const [n, sym] of list) {
      // An `export =` class also lists its prototype and statics as exports.
      if ((!IDENT.test(n) || n.startsWith('_') || n === 'prototype') && n !== 'default') continue;
      const target = resolve(sym);
      const typeOnly = (sym.declarations ?? []).some((d) => ts.isTypeOnlyImportOrExportDeclaration(d));
      const value = !typeOnly && Boolean(target.flags & ts.SymbolFlags.Value);
      let type = null;
      try { type = value ? checker.getTypeOfSymbol(target) : null; } catch { /* a value whose type cannot be read */ }
      exports.set(n, {
        value,
        deprecated: deprecation(sym) ?? deprecation(target),
        arity: arityOf(type),
        // A namespace export such as zod's z mirrors the root exports, which are compared on their own.
        statics: type ? callables(checker.getPropertiesOfType(type).filter((p) => !targets.has(resolve(p)))) : null,
      });
      if (target.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface) && !classes.has(target.name)) {
        try { classes.set(target.name, callables(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target)))); } catch { /* left out */ }
      }
    }
    surface.entries.set(sub, { file: found ? found.slice(base.length + 2) : null, exports, classes });
  }
  return surface;
}

// What a consumer of the old release would see break: functions, methods and static members that are gone, and
// functions whose required arguments changed. Everything is compared per subpath. Classes, constants and types
// that are gone are only listed, since a manual rule matches calls and they are used with new, instanceof or as types.
export function diffDeclarations(a, b) {
  const removed = new Map();
  const changed = new Map();
  const add = (map, path, kind, owner, sub, extra) => {
    if (!map.has(path)) map.set(path, { path, kinds: new Set(), owners: new Set(), subs: new Set(), ...extra });
    const x = map.get(path);
    x.kinds.add(kind);
    x.owners.add(owner);
    x.subs.add(sub);
  };
  const typesRemoved = new Set();
  const valuesRemoved = new Set();
  const exportsAdded = new Set();
  const dropped = [];
  const deprecatedNow = [];
  const notes = [];
  const label = (s, sub) => (sub === '.' ? s.name : `${s.name}/${sub.slice(2)}`);
  const compare = (path, kind, owner, sub, o, x) => {
    if (requiredChanged(o, x)) add(changed, path, kind, owner, sub, { from: o, to: x });
    else if (optionalDropped(o, x)) dropped.push({ path, in: owner, from: arityText(o), to: arityText(x) });
  };
  for (const [sub, old] of a.entries) {
    const now = b.entries.get(sub);
    if (!now) continue;
    const at = label(a, sub);
    for (const [n, o] of old.exports) {
      const x = now.exports.get(n);
      if (n === 'default') {
        if (o.value && !x?.value) notes.push(`${at} no longer has a default export`);
        continue;
      }
      if (!x || (o.value && !x.value)) {
        if (!o.value) typesRemoved.add(n);
        else {
          if (o.arity) add(removed, n, 'export', at, sub, { deprecated: o.deprecated, arity: o.arity });
          for (const [s, os] of o.statics ?? []) add(removed, `${n}.${s}`, 'static', at, sub, { deprecated: os.deprecated, arity: os.arity });
          if (!o.arity && !o.statics?.size) valuesRemoved.add(n);
        }
        continue;
      }
      if (o.arity && !x.arity) add(removed, n, 'callable', at, sub, { deprecated: o.deprecated, arity: o.arity });
      else if (o.arity && x.arity) compare(n, 'export', at, sub, o.arity, x.arity);
      if (o.deprecated === null && x.deprecated !== null) deprecatedNow.push({ path: n, in: at, note: x.deprecated });
      if (!o.statics || !x.statics) continue;
      for (const [s, os] of o.statics) {
        const xs = x.statics.get(s);
        if (!xs) add(removed, `${n}.${s}`, 'static', at, sub, { deprecated: os.deprecated, arity: os.arity });
        else compare(`${n}.${s}`, 'static', at, sub, os.arity, xs.arity);
      }
    }
    for (const [n, x] of now.exports) if (x.value && !old.exports.has(n)) exportsAdded.add(n);
    for (const [cls, methods] of old.classes) {
      const next = now.classes.get(cls);
      if (!next) continue;
      for (const [m, om] of methods) {
        const nm = next.get(m);
        if (!nm) add(removed, m, 'method', cls, sub, { deprecated: om.deprecated, arity: om.arity });
        else compare(m, 'method', cls, sub, om.arity, nm.arity);
        if (nm && om.deprecated === null && nm.deprecated !== null) deprecatedNow.push({ path: m, in: cls, note: nm.deprecated });
      }
    }
  }
  const oldSubs = a.subpaths ?? ['.'];
  const newSubs = b.subpaths ?? ['.'];
  if (!a.subpaths && b.subpaths) notes.push(`${b.name} adds an exports map, so only its listed subpaths can be imported`);
  // Paths that still mean something in the new release. The engine matches calls by path and not by subpath or
  // class, so a rename of one of these would also rename calls that are still right.
  const liveIn = (entries) => {
    const live = new Set();
    for (const e of entries) {
      for (const [n, x] of e.exports) {
        if (x.value) live.add(n);
        for (const s of x.statics?.keys() ?? []) live.add(n === 'default' ? s : `${n}.${s}`);
      }
      for (const methods of e.classes.values()) for (const m of methods.keys()) live.add(m);
    }
    return live;
  };
  const live = liveIn(b.entries.values());
  // A change only in another subpath, to a path the package root still has, would flag every call through the root.
  const root = liveIn(b.entries.has('.') ? [b.entries.get('.')] : []);
  const keep = (r) => r.subs.has('.') || !root.has(r.path);
  const sorted = (map) => [...map.values()].filter(keep).sort((x, y) => (x.path < y.path ? -1 : 1));
  return {
    old: a,
    new: b,
    removed: sorted(removed),
    changed: sorted(changed),
    live,
    typesRemoved: [...typesRemoved].sort(),
    valuesRemoved: [...valuesRemoved].sort(),
    exportsAdded: [...exportsAdded].sort(),
    optionalDropped: dropped,
    subpathsRemoved: oldSubs.filter((s) => !newSubs.includes(s)),
    subpathsAdded: newSubs.filter((s) => !oldSubs.includes(s)),
    deprecatedNow,
    notes,
  };
}

// "Use X", "Use `.x()` instead", "since 7.0, use cache.delete()" or "Renamed to {@link X}", and nothing else.
// A note that says more, such as when to use X, is not a rename.
const USE = /^(?:since [\w.]+,?\s+)?(?:please\s+)?(?:use|renamed to|replaced by|replaced with|superseded by)\s+(?:\{@link(?:code|plain)?\s+)?`?\.?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`?\}?(?:\s+instead)?\s*\.?$/i;

// A rename is drafted only when every old meaning of the path is gone, the old release's @deprecated note names
// the replacement and nothing else, the replacement is in the new release where the old one was, it accepts every
// argument count the old one did, and the path means nothing in the new release.
function renameTarget(r, diff) {
  if (r.kinds.size !== 1 || diff.live.has(r.path) || r.deprecated === null) return null;
  const kind = [...r.kinds][0];
  const m = USE.exec(r.deprecated);
  if (!m || (kind !== 'export' && kind !== 'method')) return null;
  const to = m[1].split('.').at(-1);
  if (to === r.path || !IDENT.test(to)) return null;
  for (const sub of r.subs) {
    const now = diff.new.entries.get(sub);
    if (kind === 'export') {
      const x = now.exports.get(to);
      if (!x?.value || !x.arity || !r.arity || !accepts(r.arity, x.arity)) return null;
      if (m[1].includes('.') && !now.exports.has(m[1].split('.')[0])) return null;
    } else {
      for (const cls of r.owners) {
        const x = now.classes.get(cls)?.get(to);
        const o = diff.old.entries.get(sub).classes.get(cls)?.get(r.path);
        if (!o) continue;
        if (!x || !accepts(o.arity, x.arity)) return null;
      }
    }
  }
  return to;
}

// Names and package paths only, since these reach rule prompts.
const listed = (set, max = 3) => {
  const xs = [...set].filter((x) => /^[\w$.@/~-]+$/.test(x));
  return xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', ');
};

// Turns the diff into a draft rule file. Rule prompts are built only from identifiers, versions and counts.
// @deprecated notes are package text, so they go in the evidence that a reviewer reads, never in a prompt.
export function draftFromDeclarations(diff, { provider, pkg, from, to, newVersion }) {
  const rules = [];
  const ids = new Set();
  const add = (rule) => {
    const stem = rule.id.replace(/[^\w.-]+/g, '-');
    let id = stem;
    for (let n = 2; ids.has(id); n++) id = `${stem}-${n}`;
    ids.add(id);
    rules.push({ ...rule, id });
  };
  const at = `${pkg}@${from}`;
  const note = (r) => (r.deprecated === null ? '' : r.deprecated ? ` ${at} marked it @deprecated: "${r.deprecated}".` : ` ${at} marked it @deprecated.`);
  const kept = [];
  for (const r of diff.removed) {
    const target = renameTarget(r, diff);
    if (!target) { kept.push(r); continue; }
    const what = r.kinds.has('method') ? `The method ${r.path} of ${listed(r.owners)}` : `The export ${r.path}`;
    add({ id: `rename-${r.path}`, kind: 'rename-method', confidence: 'likely', evidence: `${what} is gone from ${pkg}@${to}, and ${target} takes the same arguments there.${note(r)}`, match: { call: r.path }, transform: { to: target } });
  }
  for (const r of kept) {
    const subs = [...r.subs];
    const where = listed(new Set(subs.filter((s) => SUBPATH.test(s) || s === '.').map((s) => (s === '.' ? pkg : `${pkg}/${s.slice(2)}`)))) || pkg;
    const prompt = r.kinds.has('method') ? `The method ${r.path} of ${listed(r.owners)} was removed in ${pkg} ${to}.`
      : r.kinds.has('static') ? `${r.path} was removed in ${pkg} ${to}.`
        : r.kinds.has('callable') ? `${r.path} from ${where} is no longer a function in ${pkg} ${to}.`
          : `${r.path} is no longer exported by ${where} in ${pkg} ${to}.`;
    const still = diff.live.has(r.path) ? ` Something named ${r.path} is still in ${pkg} ${to}, in another subpath or class, so some of these calls may be right as they are.` : '';
    add({ id: `removed-${r.path}`, kind: 'manual', confidence: 'needs-review', evidence: `in the type declarations of ${at} and not of ${pkg}@${to}.${note(r)}`, match: { call: r.path }, fallback: { prompt: `${prompt}${still} Keep the behaviour identical.` } });
  }
  for (const c of diff.changed) {
    const what = c.kinds.has('method') ? `the method ${c.path} of ${listed(c.owners)}` : c.path;
    add({ id: `args-${c.path}`, kind: 'manual', confidence: 'needs-review', evidence: `${at} declares ${arityText(c.from)} arguments and ${pkg}@${to} declares ${arityText(c.to)}`, match: { call: c.path }, fallback: { prompt: `In ${pkg} ${to}, ${what} takes ${arityText(c.to)} arguments, where it took ${arityText(c.from)}. Update each call.` } });
  }
  if (newVersion && from !== to) add({ id: 'dependency', kind: 'rename-dependency', confidence: 'likely', evidence: `the new version is ${pkg}@${newVersion}`, match: { dependency: pkg }, transform: { version: `^${newVersion}` } });

  const sunset = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  return {
    ruleSet: { schema: SCHEMA, draft: true, provider, package: pkg, id: `${pkg}-${from}-to-${to}`, from, to, sunset, rules },
    report: {
      source: 'd.ts',
      subpaths: { from: [...diff.old.entries.keys()], to: [...diff.new.entries.keys()] },
      unresolvedSubpaths: { from: diff.old.unresolved, to: diff.new.unresolved },
      subpathsRemoved: diff.subpathsRemoved,
      subpathsAdded: diff.subpathsAdded,
      exportsAdded: diff.exportsAdded.slice(0, 500),
      valuesRemoved: diff.valuesRemoved.slice(0, 500),
      typesRemoved: diff.typesRemoved.slice(0, 500),
      optionalArgumentsDropped: diff.optionalDropped.slice(0, 200),
      deprecatedInNewVersion: diff.deprecatedNow.slice(0, 200),
      notes: diff.notes,
      uncovered: [
        ...diff.notes,
        ...diff.subpathsRemoved.filter((x) => SUBPATH.test(x)).map((x) => `${pkg}/${x.slice(2)} is no longer exported`),
        ...(diff.valuesRemoved.length ? [`${diff.valuesRemoved.length} classes, constants or namespaces are gone, such as ${listed(new Set(diff.valuesRemoved.filter((n) => IDENT.test(n))))}`] : []),
        ...(diff.typesRemoved.length ? [`${diff.typesRemoved.length} exported types are gone`] : []),
      ],
      likely: rules.filter((r) => r.confidence === 'likely').length,
      needsReview: rules.filter((r) => r.confidence === 'needs-review').length,
    },
  };
}

// Drafts rules for an upgrade from the declarations in both npm tarballs. manifests are the registry manifests of
// the two releases. Returns { ok, ruleSet, report, from, to } or { ok: false, reason }.
export async function draftedFromDeclarations(upgrade, manifests, { registry, fetchImpl, provider, limits } = {}) {
  const read = async (manifest) => {
    const rel = await releaseFiles(manifest, { registry, fetchImpl, limits });
    const surface = declarationSurface(rel.files, upgrade.package);
    if (!surface.entries.size) throw new Error(`${manifest.name}@${manifest.version} ships no type declarations${surface.files ? ' that resolve' : ''}`);
    return { ...rel, surface, where: { package: manifest.name, version: manifest.version, tarball: rel.url, integrity: rel.integrity, files: surface.files } };
  };
  let a;
  let b;
  try {
    a = await read(manifests.from);
    b = await read(manifests.to);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const { ruleSet, report } = draftFromDeclarations(diffDeclarations(a.surface, b.surface), { provider, pkg: upgrade.package, from: upgrade.from, to: upgrade.to, newVersion: upgrade.to });
  return { ok: true, basis: 'd.ts', ruleSet, report, from: a.where, to: b.where };
}

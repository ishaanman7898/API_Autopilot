import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA } from './rule.js';

// Stainless-style SDKs ship api.md files that list every client method with the endpoint it calls,
// and every type with the file that defines it. Nested api.md files are linked from the root one.
const METHOD = /<code title="(\w+) ([^"]+)">client((?:\.\w+)*)\.<a href="\.\/([^"]+)">(\w+)<\/a>\(([^)]*)\)(?:\s*(?:-&gt;|->)\s*([^<]*))?<\/code>/g;
const TYPE = /<code><a href="\.\/([^"]+)">(\w+)<\/a><\/code>/g;
const LINK = /\]\((?:\.\/)?(src\/[^)]*?api\.md)\)/g;
const HEADING = /^(#{1,6})[ \t]+(?:\[([^\]]*)\]\([^)]*\)|(.*?))[ \t]*$/gm;
const NAME = /^[A-Za-z_$][\w$]*$/;

// The import path of a source file inside the package: src/resources/a/b.ts becomes resources/a/b.
const modulePath = (file) => file.replace(/^src\//, '').replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');

// One api.md file: its methods and types go into the surface, and the api.md files it links to are returned.
// Each method keeps the headings it sits under, such as ['RobotsPreview', 'Jobs'], null where a heading is not a name.
function scanApiFile(surface, text) {
  const heads = [];
  let stack = [];
  for (const h of text.matchAll(HEADING)) {
    const name = (h[2] ?? h[3]).trim();
    stack = [...Array.from({ length: h[1].length - 1 }, (_, i) => stack[i] ?? null), NAME.test(name) ? name : null];
    heads.push({ at: h.index, stack });
    if (stack.every(Boolean)) surface.sections.add(stack.join('.'));
  }
  let j = -1;
  for (const m of text.matchAll(METHOD)) {
    while (j + 1 < heads.length && heads[j + 1].at < m.index) j++;
    const endpoint = `${m[1].toUpperCase()} ${m[2]}`;
    const call = [...m[3].split('.').filter(Boolean), m[5]].join('.');
    surface.methods.set(endpoint, [...(surface.methods.get(endpoint) ?? []), { call, file: m[4], args: m[6].trim(), returns: (m[7] ?? '').trim(), section: heads[j]?.stack ?? [] }]);
  }
  for (const m of text.matchAll(TYPE)) surface.types.set(m[2], new Set([...(surface.types.get(m[2]) ?? []), m[1]]));
  return [...text.matchAll(LINK)].map((m) => m[1]).filter((rel) => !rel.split('/').includes('..'));
}

const surfaceOf = (pkg, { methods, types, sections }, seen) => ({ name: pkg?.name ?? null, version: pkg?.version ?? null, methods, types, sections, files: [...seen] });

// Reads an SDK checkout: { name, version, methods: Map endpoint -> [{ call, file, args, returns, section }],
// types: Map name -> files, sections: Set of heading paths such as RobotsPreview.Jobs }.
export function readApiSurface(dir) {
  if (!existsSync(join(dir, 'api.md'))) throw new Error(`${dir} has no api.md`);
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { /* the name and version are then unknown */ }
  const surface = { methods: new Map(), types: new Map(), sections: new Set() };
  const seen = new Set();
  const queue = ['api.md'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !existsSync(join(dir, rel))) continue;
    seen.add(rel);
    queue.push(...scanApiFile(surface, readFileSync(join(dir, rel), 'utf8')));
  }
  return surfaceOf(pkg, surface, seen);
}

// The same walk over files that are fetched: read(rel) resolves to the text, or null when the file does not exist.
// Files are fetched a few at a time and scanned in the order readApiSurface would scan them.
export async function fetchApiSurface(read, pkg, { maxFiles = 2000, parallel = 8 } = {}) {
  const surface = { methods: new Map(), types: new Map(), sections: new Set() };
  const seen = new Set();
  const queue = ['api.md'];
  while (queue.length) {
    const wave = [...new Set(queue.splice(0, parallel))].filter((rel) => !seen.has(rel));
    if (seen.size + wave.length > maxFiles) throw new Error(`api.md links more than ${maxFiles} files`);
    const texts = await Promise.all(wave.map((rel) => read(rel)));
    wave.forEach((rel, i) => {
      if (texts[i] == null) return;
      seen.add(rel);
      queue.push(...scanApiFile(surface, texts[i]));
    });
    if (!seen.has('api.md')) throw new Error('there is no api.md');
  }
  return surfaceOf(pkg, surface, seen);
}

const segments = (s) => s.split('.');
function commonSuffix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

// The top-level arguments of an api.md signature such as `memberId, { ...params }`.
function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of args) {
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// What a caller has to pass: positional arguments and objects, without the placeholder names, which
// often change case between versions (memberId to memberID) without changing any call.
const argShape = (args) => splitArgs(args).map((p) => (p.startsWith('{') ? 'object' : p.startsWith('[') ? 'array' : 'value')).join(',');
const positionals = (args) => {
  const parts = splitArgs(args);
  const n = parts.findIndex((p) => p.startsWith('{') || p.startsWith('['));
  return { names: n === -1 ? parts : parts.slice(0, n), next: n === -1 ? null : parts[n] };
};
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Leading positional arguments that became keys of the params object, named after the endpoint's path
// parameters, as in Cloudflare 7: (parentId, childId, { ...params }) to (childId, { ...params }) on
// /parents/{parent_id}/children/{child_id}. Returns the keys, or null when the change is something else.
function namedPathParams(change) {
  const before = positionals(change.from);
  const after = positionals(change.to);
  if (after.names.length >= before.names.length || !after.next?.startsWith('{')) return null;
  const moved = before.names.slice(0, before.names.length - after.names.length);
  const params = [...change.endpoint.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const keys = moved.map((name) => params.find((p) => squash(p) === squash(name)));
  return keys.every(Boolean) ? { positional: before.names.length, names: keys } : null;
}

function commonPrefix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

// Methods are matched by endpoint, so a renamed call keeps its endpoint and a removed one has none.
export function diffSurfaces(a, b) {
  const renamed = [];
  const removed = [];
  const argsChanged = [];
  const returnsChanged = [];
  const pairs = [];
  const move = (fromFile, toFile) => pairs.push([modulePath(fromFile), modulePath(toFile)]);
  for (const [endpoint, olds] of a.methods) {
    const news = b.methods.get(endpoint);
    if (!news) { for (const o of olds) removed.push({ endpoint, call: o.call }); continue; }
    for (const o of olds) {
      const same = news.find((n) => n.call === o.call);
      const n = same ?? (olds.length === 1 && news.length === 1 ? news[0] : null);
      if (!n) { removed.push({ endpoint, call: o.call }); continue; }
      if (n.call !== o.call) renamed.push({ endpoint, from: o.call, to: n.call, sections: [o.section, n.section] });
      if (argShape(n.args) !== argShape(o.args)) argsChanged.push({ endpoint, call: n.call, from: o.args, to: n.args });
      else if (n.returns !== o.returns) returnsChanged.push({ endpoint, call: n.call, from: o.returns, to: n.returns });
      move(o.file, n.file);
    }
  }
  const oldCalls = new Set([...a.methods.values()].flat().map((m) => m.call));
  const newCalls = [...new Set([...b.methods.values()].flat().map((m) => m.call))];
  const added = [...b.methods.entries()].filter(([e]) => !a.methods.has(e)).flatMap(([endpoint, ns]) => ns.map((n) => ({ endpoint, call: n.call }))).filter((x) => !oldCalls.has(x.call));
  const removedTypes = [];
  for (const [name, files] of a.types) {
    const next = b.types.get(name);
    if (!next) { removedTypes.push(name); continue; }
    if (files.size === 1 && next.size === 1) move([...files][0], [...next][0]);
  }
  // A module moved only when everything defined under it moved the same way. Rename-import rules also match
  // subpaths, so one type moving into a new file must not move the whole module. Those are listed instead.
  const moves = new Map();
  const ambiguous = new Map();
  const under = (path, dir) => path === dir || path.startsWith(dir + '/');
  for (const [x0, y0] of pairs) {
    const x = x0.split('/');
    const y = y0.split('/');
    const k = commonSuffix(x, y);
    if (k === x.length && k === y.length) continue;
    const from = x.slice(0, x.length - k).join('/');
    const to = y.slice(0, y.length - k).join('/');
    if (!from || !to || moves.has(from) || ambiguous.has(from)) continue;
    const others = pairs.filter(([o, n]) => under(o, from) && n !== to + o.slice(from.length));
    if (others.length) ambiguous.set(from, { from, to, unmoved: others.length, moved: pairs.filter(([o]) => under(o, from)).length - others.length });
    else moves.set(from, to);
  }
  return { renamed, removed, added, newCalls, argsChanged, returnsChanged, removedTypes, moves: [...moves].map(([from, to]) => ({ from, to })), partialMoves: [...ambiguous.values()], newSections: b.sections ?? new Set() };
}

// The type namespace of a renamed resource, such as RobotsPreview to Robots for robotsPreview to robots, read from
// the api.md headings its methods sit under, one heading per segment of the call path. Every method has to agree,
// each heading has to match its segment apart from case, and the new version must have no section by the old name.
// Capitalising the path would be wrong: Orb's externalPlanId sits under ## ExternalPlanID.
function typeRename(list, prefix, next, newSections) {
  const named = (call, section = [], path) => {
    const segs = segments(path);
    const heads = section.slice(0, segs.length);
    return section.length === segments(call).length - 1 && heads.every((h, i) => h && squash(h) === squash(segs[i])) ? heads.join('.') : null;
  };
  const from = new Set(list.map((r) => named(r.from, r.sections?.[0], prefix)));
  const to = new Set(list.map((r) => named(r.to, r.sections?.[1], next)));
  const [a] = from;
  const [b] = to;
  return from.size === 1 && to.size === 1 && a && b && a !== b && !newSections.has(a) ? { from: a, to: b } : null;
}

// Turns the diff into a draft rule file. Every rule carries confidence and evidence, and the file is
// marked draft, so it cannot be signed until the publisher has reviewed it.
export function draftFromSurfaces(diff, { provider, from, to, oldName, newName, newVersion, oldMethods }) {
  const rules = [];
  const ids = new Set();
  const add = (rule) => {
    let id = rule.id.replace(/[^\w.-]+/g, '-');
    for (let n = 2; ids.has(id); n++) id = `${rule.id.replace(/[^\w.-]+/g, '-')}-${n}`;
    ids.add(id);
    rules.push({ ...rule, id });
  };
  const pkg = oldName;
  const target = newName ?? oldName;

  // Moved type and resource modules, most specific first, before the package itself is renamed.
  for (const m of [...diff.moves].sort((x, y) => y.from.length - x.from.length)) {
    add({ id: `move-${m.from}`, kind: 'rename-import', confidence: 'likely', evidence: `types and methods defined under ${m.from} are defined under ${m.to} in the new version`, match: { module: `${pkg}/${m.from}` }, transform: { to: `${target}/${m.to}` } });
  }
  if (newName && newName !== oldName) {
    add({ id: 'package-rename', kind: 'rename-import', confidence: 'likely', evidence: `package.json name changed from ${oldName} to ${newName}`, match: { module: oldName }, transform: { to: newName } });
  }

  // A prefix whose every method moved the same way becomes one rename-namespace rule.
  const groups = new Map();
  for (const r of diff.renamed) {
    const x = segments(r.from);
    const y = segments(r.to);
    const k = commonSuffix(x, y);
    const key = `${x.slice(0, x.length - k).join('.')} ${y.slice(0, y.length - k).join('.')}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, list] of groups) {
    const [prefix, next] = key.split(' ');
    const under = oldMethods.filter((c) => c.startsWith(prefix + '.'));
    const whole = list.length > 1 && under.length === list.length && list.every((r) => r.from.startsWith(prefix + '.'));
    if (whole) {
      add({ id: `namespace-${prefix}`, kind: 'rename-namespace', confidence: 'likely', evidence: `all ${list.length} methods under ${prefix} moved to ${next}, matched by endpoint`, match: { path: prefix }, transform: { to: next } });
      const type = typeRename(list, prefix, next, diff.newSections);
      if (type) add({ id: `type-${type.from}`, kind: 'rename-namespace', confidence: 'likely', evidence: `api.md lists every method under ${prefix} in section ${type.from} in ${from}, and every method under ${next} in section ${type.to} in ${to}, which has no section ${type.from}`, match: { path: type.from }, transform: { to: type.to } });
    } else {
      for (const r of list) add({ id: `rename-${r.from}`, kind: 'rename-method', confidence: 'likely', evidence: `same endpoint ${r.endpoint}`, match: { call: r.from }, transform: { to: r.to } });
    }
  }

  for (const r of diff.removed) {
    // A method with the same name in the new version, closest in path first, such as data.dimensions.listValues for data.filters.listValues.
    const name = r.call.split('.').at(-1);
    const shared = (c) => commonPrefix(segments(c), segments(r.call));
    const candidates = diff.newCalls.filter((c) => c !== r.call && c.split('.').at(-1) === name && shared(c) > 0)
      .sort((x, y) => shared(y) - shared(x) || (x < y ? -1 : 1)).slice(0, 2).map((c) => `client.${c}`);
    const hint = candidates.length ? ` A likely replacement is ${candidates.join(' or ')}.` : '';
    add({ id: `removed-${r.call}`, kind: 'manual', confidence: 'needs-review', evidence: `endpoint ${r.endpoint} is gone from the new version`, match: { call: r.call }, fallback: { prompt: `client.${r.call} was removed in ${target} ${to}.${hint} Keep the behaviour identical.` } });
  }
  for (const c of diff.argsChanged) {
    const named = namedPathParams(c);
    if (named) {
      add({ id: `named-${c.call}`, kind: 'positional-to-named', confidence: 'likely', evidence: `(${c.from}) became (${c.to}) on ${c.endpoint}, so ${named.names.join(', ')} moved into the params object`, match: { call: c.call, positional: named.positional }, transform: { names: named.names } });
      continue;
    }
    add({ id: `args-${c.call}`, kind: 'manual', confidence: 'needs-review', evidence: `arguments of ${c.endpoint} changed`, match: { call: c.call }, fallback: { prompt: `The arguments of client.${c.call} changed from (${c.from}) to (${c.to}). Update each call.` } });
  }
  if (newVersion && (newName !== oldName || from !== to)) {
    add({ id: 'dependency', kind: 'rename-dependency', confidence: 'likely', evidence: `the new version is ${target}@${newVersion}`, match: { dependency: oldName }, transform: { ...(target !== oldName ? { to: target } : {}), version: `^${newVersion}` } });
  }

  const sunset = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  return {
    ruleSet: { schema: SCHEMA, draft: true, provider, package: pkg, id: `${pkg}-${from}-to-${to}`, from, to, sunset, rules },
    report: {
      methodsAdded: diff.added.map((x) => x.call),
      returnTypesChanged: diff.returnsChanged,
      typesRemoved: diff.removedTypes,
      moduleMoves: diff.moves,
      partialModuleMoves: diff.partialMoves,
      likely: rules.filter((r) => r.confidence === 'likely').length,
      needsReview: rules.filter((r) => r.confidence === 'needs-review').length,
    },
  };
}

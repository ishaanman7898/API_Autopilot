import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA } from './rule.js';

// Stainless-style SDKs ship api.md files that list every client method with the endpoint it calls,
// and every type with the file that defines it. Nested api.md files are linked from the root one.
const METHOD = /<code title="(\w+) ([^"]+)">client((?:\.\w+)*)\.<a href="\.\/([^"]+)">(\w+)<\/a>\(([^)]*)\)(?:\s*(?:-&gt;|->)\s*([^<]*))?<\/code>/g;
const TYPE = /<code><a href="\.\/([^"]+)">(\w+)<\/a><\/code>/g;
const LINK = /\]\((?:\.\/)?(src\/[^)]*?api\.md)\)/g;

// The import path of a source file inside the package: src/resources/a/b.ts becomes resources/a/b.
const modulePath = (file) => file.replace(/^src\//, '').replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');

// Reads an SDK checkout: { name, version, methods: Map endpoint -> [{ call, file, args, returns }], types: Map name -> files }.
export function readApiSurface(dir) {
  if (!existsSync(join(dir, 'api.md'))) throw new Error(`${dir} has no api.md`);
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { /* the name and version are then unknown */ }
  const methods = new Map();
  const types = new Map();
  const seen = new Set();
  const queue = ['api.md'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !existsSync(join(dir, rel))) continue;
    seen.add(rel);
    const text = readFileSync(join(dir, rel), 'utf8');
    for (const m of text.matchAll(LINK)) queue.push(m[1]);
    for (const m of text.matchAll(METHOD)) {
      const endpoint = `${m[1].toUpperCase()} ${m[2]}`;
      const call = [...m[3].split('.').filter(Boolean), m[5]].join('.');
      methods.set(endpoint, [...(methods.get(endpoint) ?? []), { call, file: m[4], args: m[6].trim(), returns: (m[7] ?? '').trim() }]);
    }
    for (const m of text.matchAll(TYPE)) types.set(m[2], new Set([...(types.get(m[2]) ?? []), m[1]]));
  }
  return { name: pkg.name ?? null, version: pkg.version ?? null, methods, types, files: [...seen] };
}

const segments = (s) => s.split('.');
function commonSuffix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
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
  const moves = new Map();
  const move = (fromFile, toFile) => {
    const x = modulePath(fromFile).split('/');
    const y = modulePath(toFile).split('/');
    const k = commonSuffix(x, y);
    if (k === x.length && k === y.length) return;
    const from = x.slice(0, x.length - k).join('/');
    const to = y.slice(0, y.length - k).join('/');
    if (from && to) moves.set(from, to);
  };
  for (const [endpoint, olds] of a.methods) {
    const news = b.methods.get(endpoint);
    if (!news) { for (const o of olds) removed.push({ endpoint, call: o.call }); continue; }
    for (const o of olds) {
      const same = news.find((n) => n.call === o.call);
      const n = same ?? (olds.length === 1 && news.length === 1 ? news[0] : null);
      if (!n) { removed.push({ endpoint, call: o.call }); continue; }
      if (n.call !== o.call) renamed.push({ endpoint, from: o.call, to: n.call });
      if (n.args !== o.args) argsChanged.push({ endpoint, call: n.call, from: o.args, to: n.args });
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
  return { renamed, removed, added, newCalls, argsChanged, returnsChanged, removedTypes, moves: [...moves].map(([from, to]) => ({ from, to })) };
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
      likely: rules.filter((r) => r.confidence === 'likely').length,
      needsReview: rules.filter((r) => r.confidence === 'needs-review').length,
    },
  };
}

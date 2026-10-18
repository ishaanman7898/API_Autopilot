import ts from 'typescript';
import { buildProgram } from './parse.js';
import { createResolver } from './bindings.js';
import { filesReachingPackage } from './match.js';
import { TRANSFORMS } from './transforms.js';

const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function packageNames(rs) {
  const names = [rs.package, ...rs.rules.filter((r) => r.kind === 'rename-import').flatMap((r) => [r.match.module, r.transform.to])];
  return [...new Set(names.filter(Boolean))];
}

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let floor = Infinity;
  for (const e of sorted) {
    if (e.end > floor) throw new Error('overlapping edits, refusing to guess');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

function snippet(sf, line) {
  const lines = sf.text.split('\n');
  return lines.slice(Math.max(0, line - 3), line + 2).join('\n');
}

// The program, resolver and reach set for one version of the files. A rule that changes nothing leaves
// the files object as it was, so the next rule reuses all of it. When files did change, unchanged source
// files are carried over from the previous program instead of being parsed again.
function analysisFor(files, configs, rs, names, cache) {
  if (cache.files !== files) {
    const built = buildProgram(files, configs, cache.built?.program);
    const isPackage = (spec) => names.some((n) => spec === n || spec.startsWith(n + '/'));
    const resolver = createResolver(built.checker, isPackage);
    const ctx = { ...resolver, isPackage, packageName: rs.package ?? names[0] };
    ctx.reaches = filesReachingPackage(built.sourceFiles, built.checker, ctx);
    Object.assign(cache, { files, built, ctx });
  }
  return cache;
}

function runAstRule(rule, rs, files, configs, names, report, cache) {
  const { built, ctx } = analysisFor(files, configs, rs, names, cache);
  const edits = new Map();
  const seen = new Set();
  const out = {
    edit(sf, start, end, text, node) {
      const file = built.rel(sf);
      const key = `${file}:${start}:${end}:${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!edits.has(file)) edits.set(file, []);
      edits.get(file).push({ start, end, text, line: lineOf(sf, node.getStart(sf)) });
    },
    fail(sf, node, reason) {
      const line = lineOf(sf, node.getStart(sf));
      report.unresolved.push({ file: built.rel(sf), line, ruleId: rule.id, call: rule.match.call ?? rule.match.module ?? rule.match.path, reason, snippet: snippet(sf, line) });
    },
  };
  for (const sf of built.sourceFiles) {
    const file = built.rel(sf);
    if (built.syntaxErrors(sf)) {
      if (names.some((n) => sf.text.includes(n)) && !report.skipped.some((s) => s.file === file)) report.skipped.push({ file, reason: 'syntax errors, file not touched' });
      continue;
    }
    TRANSFORMS[rule.kind](ctx, sf, rule, out);
  }
  const writable = [...edits].filter(([file]) => !report.skipped.some((s) => s.file === file));
  if (!writable.length) return files;
  const next = { ...files };
  for (const [file, list] of writable) {
    next[file] = applyEdits(files[file], list);
    for (const e of list) report.changes.push({ file, line: e.line, ruleId: rule.id, proven: true });
  }
  return next;
}

const MANIFEST = /(?:^|\/)package\.json$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const textSnippet = (text, line) => text.split('\n').slice(Math.max(0, line - 3), line + 2).join('\n');

// Renames a dependency, sets its version range, or both, in every package.json that lists it. Edits go
// through a JSON parse, so formatting and key order are kept. Lockfiles are left to the package manager.
function runDependencyRule(rule, files, report) {
  const next = { ...files };
  const from = rule.match.dependency;
  const to = rule.transform.to ?? from;
  const { version } = rule.transform;
  for (const [file, text] of Object.entries(files)) {
    if (!MANIFEST.test(file)) continue;
    const sf = ts.parseJsonText(file, text);
    const root = sf.statements[0]?.expression;
    if (sf.parseDiagnostics?.length || !root || !ts.isObjectLiteralExpression(root)) {
      if (text.includes(JSON.stringify(from))) report.unresolved.push({ file, line: 1, ruleId: rule.id, call: from, reason: 'package.json is not valid JSON', snippet: textSnippet(text, 1) });
      continue;
    }
    const edits = [];
    for (const field of root.properties) {
      if (!ts.isPropertyAssignment(field) || !DEPENDENCY_FIELDS.includes(field.name.text) || !ts.isObjectLiteralExpression(field.initializer)) continue;
      const deps = field.initializer.properties.filter(ts.isPropertyAssignment);
      const entry = deps.find((p) => p.name.text === from);
      if (!entry) continue;
      const line = sf.getLineAndCharacterOfPosition(entry.name.getStart(sf)).line + 1;
      if (to !== from && deps.some((p) => p.name.text === to)) {
        report.unresolved.push({ file, line, ruleId: rule.id, call: from, reason: `${field.name.text} already lists ${to}`, snippet: textSnippet(text, line) });
        continue;
      }
      if (to !== from) edits.push({ start: entry.name.getStart(sf), end: entry.name.end, text: JSON.stringify(to), line });
      if (version !== undefined && ts.isStringLiteral(entry.initializer)) edits.push({ start: entry.initializer.getStart(sf), end: entry.initializer.end, text: JSON.stringify(version), line });
    }
    if (!edits.length) continue;
    next[file] = applyEdits(text, edits);
    for (const line of new Set(edits.map((e) => e.line))) report.changes.push({ file, line, ruleId: rule.id, proven: true });
  }
  return Object.keys(next).some((f) => next[f] !== files[f]) ? next : files;
}

// Regex rewrite for non-code files. These changes are not proven by a parse and are labelled as such.
function runReplaceRule(rule, files, report) {
  const next = { ...files };
  const flags = rule.match.flags ?? 'g';
  for (const [file, text] of Object.entries(files)) {
    if (!rule.match.files.some((f) => file.endsWith(f))) continue;
    const re = new RegExp(rule.match.pattern, flags);
    next[file] = text.replace(re, (m, ...rest) => {
      const offset = rest.find((x) => typeof x === 'number');
      report.changes.push({ file, line: text.slice(0, offset).split('\n').length, ruleId: rule.id, proven: false });
      return m.replace(new RegExp(rule.match.pattern, flags.replace('g', '')), rule.transform.to);
    });
  }
  return Object.keys(next).some((f) => next[f] !== files[f]) ? next : files;
}

// Deterministic pass. Rules run in order and each sees the output of the one before. Anything not proven goes to unresolved.
// configs maps paths of tsconfig.json and jsconfig.json files to their text. They are read for path aliases and never edited.
// reuseProgram false rebuilds the program for every rule. It exists to check that reuse changes nothing.
export function applyRuleSet(rs, files, configs = {}, { reuseProgram = true } = {}) {
  const report = { changes: [], unresolved: [], skipped: [] };
  const names = packageNames(rs);
  let current = { ...files };
  const cache = {};
  for (const rule of rs.rules) {
    if (rule.kind === 'replace') current = runReplaceRule(rule, current, report);
    else if (rule.kind === 'rename-dependency') current = runDependencyRule(rule, current, report);
    else current = runAstRule(rule, rs, current, configs, names, report, reuseProgram ? cache : {});
  }
  const seen = new Set();
  const unresolved = report.unresolved.filter((u) => {
    const key = `${u.file}:${u.line}:${u.ruleId}:${u.reason}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { files: current, changes: report.changes, unresolved, skipped: report.skipped };
}

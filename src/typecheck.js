import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { lineHunks } from './diffview.js';
import { AST_FILE } from './parse.js';

// Type-checks the code files a migration changed, with the repository's own compiler options and whatever is
// installed in node_modules. After the new versions are installed it checks the original text and the rewritten
// text. Both runs read the same node_modules, so a dependency that is missing fails both. Only errors the
// rewritten text adds count. The original text can also be checked before the install, against the old versions,
// because an error there can be hidden after the upgrade by another error at the same call.
// This runs TypeScript as a library, the version apimigrate ships, and never code from the repository.

const CONFIGS = ['tsconfig.json', 'jsconfig.json'];
// For a file that no config covers. JavaScript is then only checked when the file asks with // @ts-check.
const DEFAULTS = { allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, esModuleInterop: true, resolveJsonModule: true, skipLibCheck: true };
// Nothing is written, and settings that only matter when building the whole project are off.
const NO_BUILD = { noEmit: true, composite: false, incremental: false, declaration: false, declarationMap: false, emitDeclarationOnly: false, tsBuildInfoFile: undefined };
const DECLARATION = /\.d\.[cm]?ts$/;
const MAX_MESSAGE = 300;

const posixPath = (p) => p.split(sep).join('/');
const byLine = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

// The nearest tsconfig.json or jsconfig.json at or above the file, inside root. A solution-style config that
// does not list the file hands it to the first config it references that does, as in a Vite project.
function configFor(root, rel, load) {
  const file = posixPath(join(root, rel));
  for (let dir = dirname(join(root, rel)); ; dir = dirname(dir)) {
    const found = CONFIGS.map((n) => join(dir, n)).find((p) => existsSync(p));
    if (found) {
      const own = load(found);
      if (!own || own.files.has(file)) return own;
      for (const ref of own.parsed.projectReferences ?? []) {
        const other = load(ts.resolveProjectReferencePath(ref));
        if (other?.files.has(file)) return other;
      }
      return own;
    }
    if (dir === root || dirname(dir) === dir) return null;
  }
}

function errorsOf(program, sf) {
  if (!sf) return [];
  return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
    .filter((d) => d.category === ts.DiagnosticCategory.Error && d.start !== undefined)
    .map((d) => ({
      line: sf.getLineAndCharacterOfPosition(d.start).line + 1,
      end: sf.getLineAndCharacterOfPosition(d.start + (d.length ?? 0)).line + 1,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0].slice(0, MAX_MESSAGE),
    }));
}

// Each changed file's errors under one set of options, with texts overriding what is on disk.
// Source files read from disk are shared through cache, and the previous program is reused.
function check(options, roots, files, texts, cache, oldProgram) {
  const host = ts.createCompilerHost(options, true);
  const read = host.getSourceFile;
  host.getSourceFile = (name, lang, onError, fresh) => {
    if (texts.has(name)) return ts.createSourceFile(name, texts.get(name), lang, true);
    if (!cache.has(name)) cache.set(name, read.call(host, name, lang, onError, fresh));
    return cache.get(name);
  };
  const readFile = host.readFile;
  host.readFile = (name) => texts.get(name) ?? readFile.call(host, name);
  host.writeFile = () => {};
  const program = ts.createProgram({ rootNames: roots, options, host, oldProgram });
  return { program, errors: new Map(files.map((f) => [f, errorsOf(program, program.getSourceFile(f))])) };
}

// Multiset difference by key: an error is kept when after has it more often than each list in befores.
function minus(after, befores, key) {
  const left = new Map();
  for (const list of befores) {
    const counts = new Map();
    for (const e of list) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
    for (const [k, n] of counts) left.set(k, Math.max(left.get(k) ?? 0, n));
  }
  return after.filter((e) => {
    const n = left.get(key(e)) ?? 0;
    if (n) left.set(key(e), n - 1);
    return !n;
  });
}

// The errors of the rewritten text that no run of the original text has. befores lists the original text's
// errors per run. A rewrite can join or split lines, so on the lines it changed the errors are compared hunk by
// hunk, by code and message. An error belongs to the first hunk its span touches. Errors on other lines are
// compared after mapping their line back through the hunks before it. Returns { changed, other } with lines
// of the rewritten text.
export function compareErrors(beforeText, afterText, befores, after) {
  const hunks = lineHunks(beforeText, afterText);
  const hunkOf = (e, start, end) => hunks.findIndex((h) => h[start] < h[end] && e.line < h[end] && e.end >= h[start]);
  const oldLine = (line) => line - hunks.filter((h) => h.newEnd <= line).reduce((n, h) => n + (h.newEnd - h.newStart) - (h.oldEnd - h.oldStart), 0);
  const a = befores.map((list) => list.map((e) => ({ ...e, hunk: hunkOf(e, 'oldStart', 'oldEnd'), at: e.line })));
  const b = after.map((e) => ({ ...e, hunk: hunkOf(e, 'newStart', 'newEnd'), at: oldLine(e.line) }));
  const inHunk = (e) => `${e.hunk}\0${e.code}\0${e.message}`;
  const onLine = (e) => `${e.at}\0${e.code}\0${e.message}`;
  const strip = ({ line, code, message }) => ({ line, code, message });
  return {
    changed: minus(b.filter((e) => e.hunk >= 0), a.map((l) => l.filter((e) => e.hunk >= 0)), inHunk).map(strip),
    other: minus(b.filter((e) => e.hunk < 0), a.map((l) => l.filter((e) => e.hunk < 0)), onLine).map(strip),
  };
}

const changedCode = (base, head) => Object.keys(head).filter((f) => AST_FILE.test(f) && typeof base[f] === 'string' && base[f] !== head[f]).sort();

// Checks the files once per variant, a map of path to text that replaces the disk text of all the files, so a
// file of one group imported by another has the same text in both. Files are grouped by config, and the runs of
// a group share the source files read from disk. Returns the projects and, per variant, each file's errors.
function checkVariants(root, files, variants) {
  const real = realpathSync(root);
  const abs = (rel) => posixPath(join(real, rel));
  // Some messages, such as TS2306, name a file by its absolute path, which the evidence never holds.
  const prefixes = [...new Set([real, resolve(root)])].map((p) => posixPath(p) + '/');
  const local = (errors) => errors.map((e) => ({ ...e, message: prefixes.reduce((m, p) => m.split(p).join(''), e.message) }));
  const configs = new Map();
  const load = (path) => {
    if (!configs.has(path)) {
      const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
      configs.set(path, parsed ? { path, parsed, files: new Set(parsed.fileNames.map(posixPath)) } : null);
    }
    return configs.get(path);
  };
  const groups = new Map();
  for (const f of files) {
    const config = configFor(real, f, load);
    const key = config?.path ?? '';
    if (!groups.has(key)) groups.set(key, { config, files: [] });
    groups.get(key).files.push(f);
  }

  const projects = [];
  const errors = variants.map(() => ({}));
  const overlays = variants.map((texts) => new Map(files.map((f) => [abs(f), texts[f]])));
  for (const { config, files: group } of groups.values()) {
    const options = { ...(config ? config.parsed.options : DEFAULTS), ...NO_BUILD };
    const paths = group.map(abs);
    // Declaration files the config lists, so globals and module declarations are seen, as tsc would see them.
    const roots = [...new Set([...paths, ...(config ? [...config.files].filter((f) => DECLARATION.test(f)) : [])])];
    const cache = new Map();
    let previous;
    overlays.forEach((texts, i) => {
      const run = check(options, roots, paths, texts, cache, previous);
      previous = run.program;
      for (const f of group) errors[i][f] = local(run.errors.get(abs(f)));
    });
    projects.push({ config: config ? posixPath(relative(real, config.path)) : null, files: group });
  }
  return { projects, errors };
}

// The original text's errors with the versions installed now, keyed by file. apply runs this before it installs
// the new versions.
export function typecheckBaseline(root, base, head) {
  return checkVariants(root, changedCode(base, head), [base]).errors[0];
}

// base and head map repository paths to LF text. Every code file whose text differs is checked. baseline, from
// typecheckBaseline, holds the original text's errors with the old versions. Returns { ran: true, typescript,
// baseline, projects: [{ config, files }], added, otherLines }, where added are the new errors on changed lines
// and otherLines the new errors elsewhere in those files, each as { file, line, code, message }.
export function typecheckChanges(root, base, head, baseline = null) {
  const files = changedCode(base, head);
  const { projects, errors: [original, rewritten] } = checkVariants(root, files, [base, head]);
  const added = [];
  const otherLines = [];
  for (const f of files) {
    const { changed, other } = compareErrors(base[f], head[f], [original[f], baseline?.[f] ?? []], rewritten[f]);
    added.push(...changed.map((e) => ({ file: f, ...e })));
    otherLines.push(...other.map((e) => ({ file: f, ...e })));
  }
  return { ran: true, typescript: ts.version, baseline: baseline !== null, projects, added: added.sort(byLine), otherLines: otherLines.sort(byLine) };
}

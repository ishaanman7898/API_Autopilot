import { posix } from 'node:path';
import ts from 'typescript';

export const AST_FILE = /\.[cm]?[jt]sx?$/;

const OPTIONS = {
  allowJs: true,
  checkJs: false,
  noLib: true,
  noEmit: true,
  types: [],
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
};

const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// An import written with a .js extension can name a TypeScript source, as TypeScript allows.
const SOURCE_FOR = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const ENTRY_CONFIGS = ['tsconfig.json', 'jsconfig.json'];
const isRelative = (s) => s.startsWith('.') || s.startsWith('/');

// The baseUrl and paths that apply to one config file, following relative extends inside configs.
// Returns { baseUrl?, paths?, pathsBase? } with repository-relative directories.
function readConfig(path, configs, seen = new Set()) {
  if (seen.has(path) || !(path in configs)) return {};
  seen.add(path);
  const { config } = ts.parseConfigFileTextToJson(path, configs[path]);
  if (!config || typeof config !== 'object') return {};
  const dir = posix.dirname(path);
  let out = {};
  for (const parent of [].concat(config.extends ?? [])) {
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
    const target = posix.normalize(posix.join(dir, parent));
    out = { ...out, ...readConfig(target in configs ? target : target + '.json', configs, seen) };
  }
  const opts = config.compilerOptions ?? {};
  if (typeof opts.baseUrl === 'string') out.baseUrl = posix.normalize(posix.join(dir, opts.baseUrl));
  if (opts.paths && typeof opts.paths === 'object' && !Array.isArray(opts.paths)) {
    out.paths = opts.paths;
    out.pathsBase = dir;
  }
  // A solution-style tsconfig.json often keeps its aliases in a referenced config such as tsconfig.app.json.
  if (!out.paths && !out.baseUrl) {
    for (const ref of config.references ?? []) {
      if (typeof ref?.path !== 'string') continue;
      const target = posix.normalize(posix.join(dir, ref.path));
      const found = readConfig(target.endsWith('.json') ? target : posix.join(target, 'tsconfig.json'), configs, seen);
      if (found.paths || found.baseUrl) return found;
    }
  }
  return out;
}

// Where a bare specifier may point under one config, in the order TypeScript tries them.
function aliasTargets(spec, conf) {
  const out = [];
  if (conf.paths) {
    let best = null;
    for (const key of Object.keys(conf.paths)) {
      const star = key.indexOf('*');
      if (star === -1) {
        if (key === spec) best = { key, sub: '', prefix: Infinity };
        continue;
      }
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      const fits = spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix);
      if (fits && (!best || prefix.length > best.prefix)) best = { key, sub: spec.slice(prefix.length, spec.length - suffix.length), prefix: prefix.length };
    }
    for (const target of best ? [].concat(conf.paths[best.key]) : []) {
      if (typeof target === 'string') out.push(posix.join(conf.baseUrl ?? conf.pathsBase, target.replace('*', best.sub)));
    }
  }
  if (conf.baseUrl) out.push(posix.join(conf.baseUrl, spec));
  return out;
}

// Builds an in-memory program over { path: text } so the checker can resolve imports between repo files.
// configs are tsconfig.json and jsconfig.json texts. Their paths and baseUrl let a bare specifier such as
// '@/lib/client' resolve to a scanned file, using the config nearest to the importing file.
export function buildProgram(files, configs = {}) {
  const texts = new Map(Object.entries(files).map(([p, t]) => ['/' + p, t]));
  const isCode = (p) => AST_FILE.test(p) && texts.has('/' + p);
  const findFile = (candidate) => {
    const c = posix.normalize(candidate);
    if (c.startsWith('..')) return null;
    const ext = posix.extname(c);
    const tries = [c, ...EXTENSIONS.map((e) => c + e), ...(SOURCE_FOR[ext] ?? []).map((e) => c.slice(0, -ext.length) + e), ...EXTENSIONS.map((e) => posix.join(c, 'index' + e))];
    return tries.find(isCode) ?? null;
  };
  const configByDir = new Map();
  const configFor = (dir) => {
    if (!configByDir.has(dir)) {
      const own = ENTRY_CONFIGS.map((n) => (dir === '.' ? n : `${dir}/${n}`)).find((p) => p in configs);
      configByDir.set(dir, own ? readConfig(own, configs) : dir === '.' ? {} : configFor(posix.dirname(dir)));
    }
    return configByDir.get(dir);
  };

  const host = {
    getSourceFile: (name, lang) => (texts.has(name) ? ts.createSourceFile(name, texts.get(name), lang, true) : undefined),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile() {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => texts.has(f),
    readFile: (f) => texts.get(f),
    resolveModuleNameLiterals: (literals, containingFile, _ref, options) => literals.map((lit) => {
      if (!isRelative(lit.text)) {
        for (const target of aliasTargets(lit.text, configFor(posix.dirname(containingFile.slice(1)) || '.'))) {
          const found = findFile(target);
          if (found) {
            const extension = found.endsWith('.d.ts') ? ts.Extension.Dts : posix.extname(found);
            return { resolvedModule: { resolvedFileName: '/' + found, extension, isExternalLibraryImport: false } };
          }
        }
      }
      return ts.resolveModuleName(lit.text, containingFile, options, host);
    }),
  };
  const roots = [...texts.keys()].filter((f) => AST_FILE.test(f));
  const program = ts.createProgram({ rootNames: roots, options: OPTIONS, host });
  const sourceFiles = roots.map((r) => program.getSourceFile(r)).filter(Boolean);
  const syntaxErrors = (sf) => program.getSyntacticDiagnostics(sf).length > 0;
  return { program, checker: program.getTypeChecker(), sourceFiles, syntaxErrors, rel: (sf) => sf.fileName.slice(1) };
}

export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

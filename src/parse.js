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

// Builds an in-memory program over { path: text } so the checker can resolve imports between repo files.
export function buildProgram(files) {
  const texts = new Map(Object.entries(files).map(([p, t]) => ['/' + p, t]));
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

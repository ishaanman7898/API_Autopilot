import ts from 'typescript';
import { walk } from './parse.js';

const MAX_DEPTH = 16;
const isRelative = (s) => s.startsWith('.') || s.startsWith('/');
const keyName = (k) => (ts.isIdentifier(k) || ts.isStringLiteralLike(k) ? k.text : null);

// Markers used while working out every value a function or a variable can hold. They never leave the resolver.
const NULLISH = Object.freeze({ nullish: true });
const GLOBAL_NAMES = new Set(['globalThis', 'global', 'window', 'self']);
const PENDING = Object.freeze({ pending: true });

export function unwrap(n) {
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n) || ts.isAwaitExpression(n)
  ) n = n.expression;
  return n;
}

export const fullPath = (o) => (o.root === 'named' ? [o.name] : []).concat(o.props);

// The import('x') type whose qualifier starts with this identifier, as Job does in import('x').Job.Status.
export function importTypeOf(id) {
  let q = id;
  while (q.parent && ts.isQualifiedName(q.parent) && q.parent.left === q) q = q.parent;
  return q.parent && ts.isImportTypeNode(q.parent) && q.parent.qualifier === q ? q.parent : null;
}

const sameOrigin = (a, b) => a.module === b.module && a.root === b.root && a.name === b.name && a.props.join('.') === b.props.join('.');

// The single package value behind several possible values, or null. null and undefined are allowed
// alongside it, and so is a reference back to the value being worked out (PENDING).
function join(values) {
  let out = null;
  for (const v of values) {
    if (v === NULLISH || v === PENDING) continue;
    if (!v?.module || (out && !sameOrigin(out, v))) return null;
    out = out ?? v;
  }
  return out && { module: out.module, root: out.root, ...(out.name ? { name: out.name } : {}), props: out.props };
}

// An origin says which export of a package a value came from: { module, root, name?, props, site? }.
// root is namespace, default, named or instance. site is the binding that introduced the last path segment.
// { fn } is a function whose call can be traced through its return statements.
// sourceFiles are every scanned file, which a global cache such as globalThis.__client is checked across.
export function createResolver(checker, isPackage, sourceFiles = []) {
  const pendingSymbols = new Set();
  const pendingFunctions = new Set();
  const pendingGlobals = new Set();

  const isGlobalRequire = (callee) => {
    if (!ts.isIdentifier(callee) || callee.text !== 'require') return false;
    const sym = checker.getSymbolAtLocation(callee);
    return !sym || !sym.declarations?.length;
  };

  function moduleArg(call) {
    const arg = call.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg)) return null;
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return arg.text;
    return isGlobalRequire(call.expression) ? arg.text : null;
  }

  function extend(base, name, site, depth) {
    if (base === PENDING || base.fn) return null;
    if (base.local) {
      const exported = checker.getExportsOfModule(base.local).find((s) => s.name === name);
      return exported ? fromSymbol(exported, depth + 1) : null;
    }
    if (base.obj) {
      const prop = base.obj.properties.find((p) => p.name && keyName(p.name) === name);
      return prop ? fromObjectProperty(prop, depth) : null;
    }
    if (base.root === 'namespace' && base.props.length === 0 && name === 'default') return { ...base, root: 'default', site };
    return { ...base, props: [...base.props, name], site };
  }

  function fromModuleRef(sym, spec, kind, name, site, depth) {
    if (isPackage(spec)) {
      const root = kind === 'named' ? 'named' : kind;
      return { module: spec, root, ...(kind === 'named' ? { name } : {}), props: [], site };
    }
    let target;
    try { target = checker.getImmediateAliasedSymbol(sym); } catch { target = null; }
    // A bare specifier names another package, unless a tsconfig path alias resolved it to a scanned file.
    if (!target?.declarations?.length) return isRelative(spec) ? null : { module: spec, root: 'other', props: [] };
    if (kind === 'namespace' && target.flags & ts.SymbolFlags.ValueModule) return fromModuleSymbol(target, depth);
    return fromSymbol(target, depth + 1);
  }

  // A scanned module as a value: its export= value for CommonJS `module.exports = ...`, else its exports.
  function fromModuleSymbol(mod, depth) {
    const assigned = mod.exports?.get('export=');
    if (!assigned) return { local: mod };
    const decl = assigned.valueDeclaration ?? assigned.declarations?.[0];
    if (decl && ts.isBinaryExpression(decl)) {
      const value = unwrap(decl.right);
      return ts.isObjectLiteralExpression(value) ? { obj: value } : originOf(value, depth + 1);
    }
    return decl ? fromDeclaration(decl, depth) : null;
  }

  // require('x'), import('x') and the type import('x'), given the string literal. A scanned file is followed,
  // a relative path that resolves to nothing is unknown, and anything else is another package.
  function fromRequire(lit, spec, depth) {
    const mod = checker.getSymbolAtLocation(lit);
    const file = mod?.declarations?.[0];
    if (file && ts.isSourceFile(file)) return fromModuleSymbol(mod, depth);
    return isRelative(spec) ? null : { module: spec, root: 'other', props: [] };
  }

  const isExportsObject = (n) => {
    n = unwrap(n);
    return (ts.isIdentifier(n) && n.text === 'exports') || (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'module' && n.name.text === 'exports');
  };

  // A property of an object assigned to module.exports, unless the file assigns that property again.
  function fromObjectProperty(prop, depth) {
    const obj = prop.parent;
    if (obj.properties.some(ts.isSpreadAssignment)) return null;
    const name = keyName(prop.name);
    let reassigned = false;
    walk(prop.getSourceFile(), (n) => {
      if (reassigned || !ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const left = unwrap(n.left);
      if (ts.isPropertyAccessExpression(left) && left.name.text === name && isExportsObject(left.expression)) reassigned = true;
    });
    if (reassigned) return null;
    if (ts.isShorthandPropertyAssignment(prop)) return fromSymbol(checker.getShorthandAssignmentValueSymbol(prop), depth + 1);
    if (ts.isPropertyAssignment(prop)) return originOf(prop.initializer, depth + 1);
    return null;
  }

  function fromAlias(sym, decl, depth) {
    if (ts.isImportSpecifier(decl)) {
      const name = (decl.propertyName ?? decl.name).text;
      const spec = decl.parent.parent.parent.moduleSpecifier.text;
      return fromModuleRef(sym, spec, name === 'default' ? 'default' : 'named', name, decl, depth);
    }
    if (ts.isImportClause(decl)) return fromModuleRef(sym, decl.parent.moduleSpecifier.text, 'default', 'default', decl, depth);
    if (ts.isNamespaceImport(decl)) return fromModuleRef(sym, decl.parent.parent.moduleSpecifier.text, 'namespace', null, decl, depth);
    if (ts.isNamespaceExport(decl)) return fromModuleRef(sym, decl.parent.moduleSpecifier.text, 'namespace', null, decl, depth);
    if (ts.isImportEqualsDeclaration(decl) && ts.isExternalModuleReference(decl.moduleReference)) {
      const lit = decl.moduleReference.expression;
      return ts.isStringLiteralLike(lit) ? fromModuleRef(sym, lit.text, 'namespace', null, decl, depth) : null;
    }
    if (ts.isExportSpecifier(decl)) {
      const clause = decl.parent.parent;
      if (clause.moduleSpecifier) {
        const name = (decl.propertyName ?? decl.name).text;
        return fromModuleRef(sym, clause.moduleSpecifier.text, name === 'default' ? 'default' : 'named', name, decl, depth);
      }
      return fromSymbol(checker.getExportSpecifierLocalTargetSymbol(decl), depth + 1);
    }
    return null;
  }

  const isConst = (decl) => (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;

  const isNullish = (n) => {
    n = unwrap(n);
    if (n.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(n)) return true;
    return ts.isIdentifier(n) && n.text === 'undefined' && !checker.getSymbolAtLocation(n)?.declarations?.length;
  };
  const valueOf = (n, depth) => (isNullish(n) ? NULLISH : originOf(n, depth));

  // How an identifier is used: read, assigned with =, ??= or ||= (each stores the right side), or written some other way.
  function writeOf(id) {
    const p = id.parent;
    if (ts.isBinaryExpression(p) && p.left === id) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) return { op: '=', value: p.right };
      if (op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken) return { op: '??=', value: p.right };
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return 'other';
    }
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return 'other';
    // A destructuring or loop target, such as [client] = list or for (client of list).
    let node = id;
    while (ts.isArrayLiteralExpression(node.parent) || ts.isObjectLiteralExpression(node.parent) || ts.isSpreadElement(node.parent) || ts.isSpreadAssignment(node.parent) ||
      ts.isShorthandPropertyAssignment(node.parent) || (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) || ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const q = node.parent;
    if (node !== id && ts.isBinaryExpression(q) && q.left === node && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) return 'other';
    if ((ts.isForOfStatement(q) || ts.isForInStatement(q)) && q.initializer === node) return 'other';
    return 'read';
  }

  // A let or var is followed when every value it is ever given in its file is the same package value,
  // null or undefined. That covers a lazily created client such as `let client = null; ... client = new Acme()`.
  function fromMutable(decl, depth) {
    const sym = checker.getSymbolAtLocation(decl.name);
    if (!sym) return null;
    if (pendingSymbols.has(sym)) return PENDING;
    pendingSymbols.add(sym);
    try {
      const values = [decl.initializer ? valueOf(decl.initializer, depth + 1) : NULLISH];
      let otherWrite = false;
      walk(decl.getSourceFile(), (n) => {
        if (otherWrite || !ts.isIdentifier(n) || n === decl.name || checker.getSymbolAtLocation(n) !== sym) return;
        const w = writeOf(n);
        if (w === 'other') otherWrite = true;
        else if (w !== 'read') values.push(valueOf(w.value, depth + 1));
      });
      return otherWrite ? null : join(values);
    } finally {
      pendingSymbols.delete(sym);
    }
  }

  // globalThis, global, window and self, when nothing in the scanned files declares that name, and a const
  // that holds one of them, such as `const globalForClient = globalThis as unknown as { client?: Acme }`.
  function isGlobalObject(n, depth = 0) {
    n = unwrap(n);
    if (!ts.isIdentifier(n) || depth > 3) return false;
    const sym = checker.getSymbolAtLocation(n);
    if (GLOBAL_NAMES.has(n.text) && !sym?.declarations?.length) return true;
    const decl = sym?.valueDeclaration;
    return Boolean(decl && ts.isVariableDeclaration(decl) && isConst(decl) && decl.initializer && isGlobalObject(decl.initializer, depth + 1));
  }

  // A property of the global object used as a cache, such as `globalThis.__client ?? makeClient()`, is
  // followed when every assignment to it in the scanned files gives the same package value, null or
  // undefined. A write with a computed key or a compound operator, or no write at all, leaves it unknown.
  function fromGlobalCache(name, depth) {
    if (pendingGlobals.has(name)) return PENDING;
    pendingGlobals.add(name);
    try {
      const values = [];
      let unknownWrite = false;
      for (const sf of sourceFiles) {
        walk(sf, (n) => {
          if (unknownWrite || !ts.isBinaryExpression(n)) return;
          const op = n.operatorToken.kind;
          if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return;
          const left = unwrap(n.left);
          let key;
          if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) key = left.name.text;
          else if (ts.isElementAccessExpression(left)) key = ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : null;
          else return;
          if (!isGlobalObject(left.expression)) return;
          if (key === null) unknownWrite = true;
          else if (key !== name) return;
          else if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken) values.push(valueOf(n.right, depth + 1));
          else unknownWrite = true;
        });
      }
      return unknownWrite || !values.length ? null : join(values);
    } finally {
      pendingGlobals.delete(name);
    }
  }

  // A call is followed when every return of the function gives the same package value, null or undefined.
  function fromFunction(fn, depth) {
    if (!fn.body || fn.asteriskToken) return null;
    if (pendingFunctions.has(fn)) return PENDING;
    pendingFunctions.add(fn);
    try {
      if (!ts.isBlock(fn.body)) return join([valueOf(fn.body, depth + 1)]);
      const values = [];
      const visit = (n) => {
        if (n !== fn.body && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
        if (ts.isReturnStatement(n)) values.push(n.expression ? valueOf(n.expression, depth + 1) : NULLISH);
        ts.forEachChild(n, visit);
      };
      visit(fn.body);
      return join(values);
    } finally {
      pendingFunctions.delete(fn);
    }
  }

  // A type annotation that names a package export, such as `client: Acme`, `client: Acme | null` or
  // `client: acme.Client`, is read as an instance of it.
  function fromTypeAnnotation(type, depth) {
    if (!type) return null;
    if (ts.isParenthesizedTypeNode(type)) return fromTypeAnnotation(type.type, depth);
    if (ts.isUnionTypeNode(type)) {
      const parts = type.types.filter((m) => !(ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword) && m.kind !== ts.SyntaxKind.UndefinedKeyword);
      return parts.length === 1 ? fromTypeAnnotation(parts[0], depth) : null;
    }
    if (!ts.isTypeReferenceNode(type) || type.typeArguments?.length) return null;
    const names = [];
    let n = type.typeName;
    while (ts.isQualifiedName(n)) { names.unshift(n.right.text); n = n.left; }
    let base = fromSymbol(checker.getSymbolAtLocation(n), depth + 1);
    for (const name of names) base = base && extend(base, name, undefined, depth);
    return base?.module && isPackage(base.module) ? { module: base.module, root: 'instance', props: [] } : null;
  }

  // An untyped parameter of a local function, when every call to the function passes the same package
  // value. A function that is exported, or used other than by calling it, can have callers that are not
  // seen, so its parameters are not followed.
  function fromParameter(param, depth) {
    const typed = fromTypeAnnotation(param.type, depth);
    if (typed || param.type) return typed;
    const fn = param.parent;
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    const holder = ts.isFunctionDeclaration(fn) ? fn : ts.isVariableDeclaration(fn.parent) && fn.parent.initializer === fn && isConst(fn.parent) ? fn.parent : null;
    if (!holder?.name || !ts.isIdentifier(holder.name)) return null;
    const exported = (ts.getCombinedModifierFlags(holder) & ts.ModifierFlags.Export) !== 0;
    const fnSymbol = checker.getSymbolAtLocation(holder.name);
    const paramSymbol = checker.getSymbolAtLocation(param.name);
    if (exported || !fnSymbol || !paramSymbol) return null;
    if (pendingSymbols.has(paramSymbol)) return PENDING;
    pendingSymbols.add(paramSymbol);
    try {
      const index = fn.parameters.indexOf(param);
      const values = [];
      let escapes = false;
      walk(holder.getSourceFile(), (n) => {
        if (escapes || !ts.isIdentifier(n) || n === holder.name || checker.getSymbolAtLocation(n) !== fnSymbol) return;
        const call = n.parent;
        if (!ts.isCallExpression(call) || call.expression !== n) { escapes = true; return; }
        const arg = call.arguments[index];
        if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) { escapes = true; return; }
        values.push(arg ? valueOf(arg, depth + 1) : param.initializer ? valueOf(param.initializer, depth + 1) : NULLISH);
      });
      return escapes || !values.length ? null : join(values);
    } finally {
      pendingSymbols.delete(paramSymbol);
    }
  }

  function fromDeclaration(decl, depth) {
    if (ts.isFunctionDeclaration(decl)) return { fn: decl };
    if (ts.isParameter(decl)) return fromParameter(decl, depth);
    // A class field typed with the SDK class, or a readonly field initialised with the client.
    if (ts.isPropertyDeclaration(decl)) {
      const typed = fromTypeAnnotation(decl.type, depth);
      if (typed || decl.type) return typed;
      const readonly = (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly) !== 0;
      return readonly && decl.initializer ? originOf(decl.initializer, depth + 1) : null;
    }
    if (ts.isVariableDeclaration(decl)) {
      if (!ts.isIdentifier(decl.name)) return null;
      if (!isConst(decl)) return ts.isVariableDeclarationList(decl.parent) && !ts.isCatchClause(decl.parent.parent) ? fromMutable(decl, depth) : null;
      return decl.initializer ? originOf(decl.initializer, depth + 1) : null;
    }
    if (ts.isBindingElement(decl)) {
      if (decl.dotDotDotToken || !ts.isObjectBindingPattern(decl.parent)) return null;
      const name = keyName(decl.propertyName ?? decl.name);
      if (!name) return null;
      const holder = decl.parent.parent;
      let base = null;
      if (ts.isVariableDeclaration(holder)) {
        if (!holder.initializer || !isConst(holder)) return null;
        base = originOf(holder.initializer, depth + 1);
      } else if (ts.isBindingElement(holder)) base = fromDeclaration(holder, depth + 1);
      return base && extend(base, name, decl, depth);
    }
    if (ts.isExportAssignment(decl)) return originOf(decl.expression, depth + 1);
    // CommonJS: the property of a module.exports object, and `exports.client = ...` or `module.exports = ...`.
    if ((ts.isShorthandPropertyAssignment(decl) || ts.isPropertyAssignment(decl)) && ts.isObjectLiteralExpression(decl.parent)) return fromObjectProperty(decl, depth);
    if (ts.isPropertyAccessExpression(decl) && ts.isBinaryExpression(decl.parent) && decl.parent.left === decl && decl.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return originOf(decl.parent.right, depth + 1);
    if (ts.isBinaryExpression(decl) && decl.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const value = unwrap(decl.right);
      return ts.isObjectLiteralExpression(value) ? { obj: value } : originOf(value, depth + 1);
    }
    return null;
  }

  function fromSymbol(sym, depth) {
    if (!sym || depth > MAX_DEPTH) return null;
    if (sym.flags & ts.SymbolFlags.Alias) {
      const decl = sym.declarations?.[0];
      if (!decl) return null;
      // `export default client` makes the default export an alias of the local binding, and CommonJS
      // `module.exports = { client }` makes each property an alias of its value.
      const local = ts.isVariableDeclaration(decl) || ts.isBindingElement(decl) || ts.isExportAssignment(decl) ||
        ts.isShorthandPropertyAssignment(decl) || ts.isPropertyAssignment(decl) || ts.isBinaryExpression(decl) || ts.isPropertyAccessExpression(decl);
      return local ? fromDeclaration(decl, depth) : fromAlias(sym, decl, depth);
    }
    // `exports.client = a` in two places gives one symbol with two declarations, so every one must agree.
    const decls = sym.declarations ?? [];
    if (decls.length > 1 && decls.every((d) => ts.isPropertyAccessExpression(d) && ts.isBinaryExpression(d.parent))) {
      return join(decls.map((d) => (d.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? valueOf(d.parent.right, depth + 1) : null)));
    }
    const decl = sym.valueDeclaration ?? decls[0];
    return decl ? fromDeclaration(decl, depth) : null;
  }

  function originOf(node, depth = 0) {
    node = unwrap(node);
    if (depth > MAX_DEPTH) return null;
    if (ts.isIdentifier(node)) {
      const holder = importTypeOf(node);
      if (!holder) return fromSymbol(checker.getSymbolAtLocation(node), depth + 1);
      const base = originOf(holder, depth + 1);
      return base && extend(base, node.text, undefined, depth);
    }
    // Names in types, such as Acme.Jobs.Job, typeof client.jobs and import('acme-sdk').Job, read like property accesses.
    if (ts.isQualifiedName(node)) {
      const base = originOf(node.left, depth + 1);
      return base && extend(base, node.right.text, undefined, depth);
    }
    if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal) ? node.argument.literal : null;
      if (!lit) return null;
      return isPackage(lit.text) ? { module: lit.text, root: 'namespace', props: [] } : fromRequire(lit, lit.text, depth);
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { fn: node };
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.name) && isGlobalObject(node.expression)) return fromGlobalCache(node.name.text, depth + 1);
      // this.client inside a class: the field's declaration, or a constructor parameter property.
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) return fromSymbol(checker.getSymbolAtLocation(node.name), depth + 1);
      const base = originOf(node.expression, depth + 1);
      return base && ts.isIdentifier(node.name) ? extend(base, node.name.text, undefined, depth) : null;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const base = originOf(node.expression, depth + 1);
      return base && extend(base, node.argumentExpression.text, undefined, depth);
    }
    if (ts.isNewExpression(node)) {
      const base = originOf(node.expression, depth + 1);
      return base?.module ? { module: base.module, root: 'instance', props: [] } : null;
    }
    if (ts.isCallExpression(node)) {
      const spec = moduleArg(node);
      if (spec !== null) return isPackage(spec) ? { module: spec, root: 'namespace', props: [] } : fromRequire(node.arguments[0], spec, depth);
      const base = originOf(node.expression, depth + 1);
      if (base?.fn) return fromFunction(base.fn, depth + 1);
      return base?.module ? { module: base.module, root: 'instance', props: [] } : null;
    }
    if (ts.isConditionalExpression(node)) return join([valueOf(node.whenTrue, depth + 1), valueOf(node.whenFalse, depth + 1)]);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return join([valueOf(node.left, depth + 1), valueOf(node.right, depth + 1)]);
      if (op === ts.SyntaxKind.EqualsToken) return originOf(node.right, depth + 1);
      if (op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken) return join([valueOf(node.left, depth + 1), valueOf(node.right, depth + 1)]);
    }
    return null;
  }

  // Callers only ever see a package origin, a function, a local module or null, never the internal markers.
  // The program does not change while a resolver lives, so each node's answer is computed once.
  const memo = new WeakMap();
  const publicOrigin = (n) => {
    if (!memo.has(n)) {
      const o = originOf(n, 0);
      memo.set(n, o === PENDING || o === NULLISH ? null : o);
    }
    return memo.get(n);
  };
  // A name the scanned files declare themselves rather than import, such as a local namespace or interface.
  // No library files are loaded, so every declaration the checker knows is in a scanned file.
  const declaredHere = (id) => {
    const sym = checker.getSymbolAtLocation(id);
    return Boolean(sym && !(sym.flags & ts.SymbolFlags.Alias) && sym.declarations?.length);
  };
  return { originOf: publicOrigin, moduleArg, declaredHere };
}

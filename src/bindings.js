import ts from 'typescript';
import { walk } from './parse.js';

const MAX_DEPTH = 16;
const isRelative = (s) => s.startsWith('.') || s.startsWith('/');
const keyName = (k) => (ts.isIdentifier(k) || ts.isStringLiteralLike(k) ? k.text : null);

// Markers used while working out every value a function or a variable can hold. They never leave the resolver.
const NULLISH = Object.freeze({ nullish: true });
const PENDING = Object.freeze({ pending: true });

export function unwrap(n) {
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n) || ts.isAwaitExpression(n)
  ) n = n.expression;
  return n;
}

export const fullPath = (o) => (o.root === 'named' ? [o.name] : []).concat(o.props);

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
export function createResolver(checker, isPackage) {
  const pendingSymbols = new Set();
  const pendingFunctions = new Set();

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

  // require('x') and import('x'). A scanned file is followed, a relative path that resolves to
  // nothing is unknown, and anything else is another package.
  function fromRequire(call, spec, depth) {
    const mod = checker.getSymbolAtLocation(call.arguments[0]);
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

  function fromDeclaration(decl, depth) {
    if (ts.isFunctionDeclaration(decl)) return { fn: decl };
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
    if (ts.isIdentifier(node)) return fromSymbol(checker.getSymbolAtLocation(node), depth + 1);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { fn: node };
    if (ts.isPropertyAccessExpression(node)) {
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
      if (spec !== null) return isPackage(spec) ? { module: spec, root: 'namespace', props: [] } : fromRequire(node, spec, depth);
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
  return { originOf: publicOrigin, moduleArg };
}

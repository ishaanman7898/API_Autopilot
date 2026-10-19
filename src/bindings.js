import ts from 'typescript';
import { walk } from './parse.js';

const MAX_DEPTH = 16;
const isRelative = (s) => s.startsWith('.') || s.startsWith('/');
const keyName = (k) => (ts.isIdentifier(k) || ts.isStringLiteralLike(k) ? k.text : null);
const memberKey = (k) => (ts.isPrivateIdentifier(k) ? k.text : keyName(k));
const isStatic = (m) => (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0;

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

// The outermost of the parentheses, `as`, `!` and `satisfies` wrapped around n, the reverse of unwrap.
function outer(n) {
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isNonNullExpression(n.parent) ||
    ts.isTypeAssertionExpression(n.parent) || ts.isSatisfiesExpression(n.parent))) n = n.parent;
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
const sameValue = (a, b) => (a.module ? Boolean(b.module) && sameOrigin(a, b) : ['fn', 'obj', 'cls', 'inst', 'local'].some((k) => a[k] && a[k] === b[k]));

// The single value behind several possible values, or null. null and undefined are allowed
// alongside it, and so is a reference back to the value being worked out (PENDING).
function join(values) {
  let out = null;
  for (const v of values) {
    if (v === NULLISH || v === PENDING) continue;
    if (!v || (out && !sameValue(out, v))) return null;
    out = out ?? v;
  }
  if (!out?.module) return out;
  return { module: out.module, root: out.root, ...(out.name ? { name: out.name } : {}), props: out.props };
}

// An origin says which export of a package a value came from: { module, root, name?, props, site? }.
// root is namespace, default, named or instance. site is the binding that introduced the last path segment.
// { fn } is a function whose call can be traced through its return statements. { cls } is a local class,
// { inst } an instance of one, and { obj } an object literal, whose members are traced like variables.
// sourceFiles are every scanned file, which a global cache such as globalThis.__client is checked across.
export function createResolver(checker, isPackage, sourceFiles = []) {
  const pendingSymbols = new Set();
  const pendingFunctions = new Set();
  const pendingGlobals = new Set();
  const pendingParams = new Set();

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
    if (base.obj && isExportsLiteral(base.obj)) {
      const prop = base.obj.properties.find((p) => p.name && keyName(p.name) === name);
      if (!prop) return null;
      return ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) ? fromObjectProperty(prop, depth) : fromMember(base.obj, name, false, depth);
    }
    if (base.obj || base.inst || base.cls) return fromMember(base.obj ?? base.inst ?? base.cls, name, Boolean(base.cls), depth);
    if (!base.module) return null;
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
  // The object literal of `module.exports = { ... }`, whose properties are the module's exports.
  const isExportsLiteral = (obj) => {
    const p = outer(obj).parent;
    return ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && unwrap(p.right) === obj && isExportsObject(p.left);
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
    const writes = globalWrites();
    if (writes.unknown) return null;
    if (pendingGlobals.has(name)) return PENDING;
    pendingGlobals.add(name);
    try {
      const list = writes.byName.get(name) ?? [];
      return !list.length || list.includes(null) ? null : join(list.map((right) => valueOf(right, depth + 1)));
    } finally {
      pendingGlobals.delete(name);
    }
  }
  // Every assignment to a property of the global object in the scanned files, found once: the right side by
  // property name, or null for a compound operator. unknown is set by a write with a computed key.
  let globalIndex = null;
  function globalWrites() {
    if (globalIndex) return globalIndex;
    globalIndex = { unknown: false, byName: new Map() };
    for (const sf of sourceFiles) {
      walk(sf, (n) => {
        if (!ts.isBinaryExpression(n)) return;
        const op = n.operatorToken.kind;
        if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return;
        const left = unwrap(n.left);
        let key;
        if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) key = left.name.text;
        else if (ts.isElementAccessExpression(left)) key = ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : null;
        else return;
        if (!isGlobalObject(left.expression)) return;
        if (key === null) { globalIndex.unknown = true; return; }
        if (!globalIndex.byName.has(key)) globalIndex.byName.set(key, []);
        const stores = op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken;
        globalIndex.byName.get(key).push(stores ? n.right : null);
      });
    }
    return globalIndex;
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

  // A member of a local class or object literal: a method gives { fn }, a getter what it returns, and a field or
  // property its value. statics picks static class members. A member missing from a class is looked up in the
  // local class it extends.
  function fromMember(holder, name, statics, depth) {
    if (!name || depth > MAX_DEPTH) return null;
    const literal = ts.isObjectLiteralExpression(holder);
    const own = literal ? holder.properties : holder.members.filter((m) => !ts.isConstructorDeclaration(m) && isStatic(m) === statics);
    const found = own.filter((m) => m.name && memberKey(m.name) === name);
    if (!literal && !statics) found.push(...parameterProperties(holder).filter((p) => p.name.text === name));
    if (!found.length) {
      const base = literal ? null : baseClass(holder);
      return base ? fromMember(base, name, statics, depth + 1) : null;
    }
    // One member, a getter with or without its setter, or overloads of one method. In a literal a later spread
    // or computed key can replace it.
    const getter = found.find(ts.isGetAccessorDeclaration);
    const bodies = found.filter((m) => ts.isMethodDeclaration(m) && m.body);
    let member = null;
    if (getter && found.every((m) => m === getter || ts.isSetAccessorDeclaration(m))) member = getter;
    else if (bodies.length === 1 && found.every(ts.isMethodDeclaration)) member = bodies[0];
    else if (found.length === 1 && !ts.isMethodDeclaration(found[0]) && !ts.isSetAccessorDeclaration(found[0])) member = found[0];
    if (!member) return null;
    if (literal) {
      const last = Math.max(...found.map((m) => holder.properties.indexOf(m)));
      if (holder.properties.slice(last + 1).some((p) => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name)))) return null;
    }
    // Class fields keep their own rules: a type annotation, or readonly with an initializer.
    if (ts.isPropertyDeclaration(member) || ts.isParameter(member)) return fromDeclaration(member, depth + 1);
    if (reassigned(name, holder) || (literal ? escapes(holder) : overridden(holder, name, statics))) return null;
    if (ts.isMethodDeclaration(member)) return { fn: member };
    if (ts.isGetAccessorDeclaration(member)) return fromFunction(member, depth + 1);
    if (ts.isPropertyAssignment(member)) return originOf(member.initializer, depth + 1);
    if (ts.isShorthandPropertyAssignment(member)) return fromSymbol(checker.getShorthandAssignmentValueSymbol(member), depth + 1);
    return null;
  }

  const parameterProperties = (cls) => {
    const ctor = cls.members.find((m) => ts.isConstructorDeclaration(m) && m.body);
    return ctor ? ctor.parameters.filter((p) => ts.isParameterPropertyDeclaration(p, ctor) && ts.isIdentifier(p.name)) : [];
  };

  // The local class a class expression or declaration names, through imports and a const that holds a class expression.
  function classOf(expr) {
    let sym = checker.getSymbolAtLocation(unwrap(expr));
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try { sym = checker.getAliasedSymbol(sym); } catch { return null; }
    }
    let decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && isConst(decl) && decl.initializer) decl = unwrap(decl.initializer);
    return decl && ts.isClassLike(decl) ? decl : null;
  }
  const baseClass = (cls) => {
    const ext = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    return ext ? classOf(ext.expression) : null;
  };

  // The method, accessor, constructor or field whose `this` is the one at n, or null in a plain function or at the top level.
  function thisMember(n) {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isArrowFunction(p)) continue;
      const member = ts.isMethodDeclaration(p) || ts.isAccessor(p) || ts.isConstructorDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isClassStaticBlockDeclaration(p);
      if (member && (ts.isClassLike(p.parent) || ts.isObjectLiteralExpression(p.parent))) return p;
      if (ts.isFunctionLike(p) || ts.isClassLike(p) || ts.isSourceFile(p)) return null;
    }
    return null;
  }

  // Every write to a property by name in the scanned files: an assignment, `delete`, `++` or `--`, or a destructuring or loop target.
  let writeIndex = null;
  function writesTo(name) {
    if (!writeIndex) {
      writeIndex = new Map();
      for (const sf of sourceFiles) {
        walk(sf, (n) => {
          let key = null;
          if (ts.isPropertyAccessExpression(n)) key = memberKey(n.name);
          else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) key = n.argumentExpression.text;
          if (key === null || (!ts.isDeleteExpression(outer(n).parent) && writeOf(n) === 'read')) return;
          if (!writeIndex.has(key)) writeIndex.set(key, []);
          writeIndex.get(key).push(n);
        });
      }
    }
    return writeIndex.get(name) ?? [];
  }
  // A member is reassigned when its name is written anywhere, except through `this` in a class or object literal
  // that has nothing to do with the holder, such as another class setting its own field of the same name.
  const reassigned = (name, holder) => writesTo(name).some((w) => {
    if (unwrap(w.expression).kind !== ts.SyntaxKind.ThisKeyword) return true;
    const writer = thisMember(w)?.parent;
    if (!writer || writer === holder) return true;
    return ts.isClassLike(writer) && ts.isClassLike(holder) && (descendants(holder).includes(writer) || descendants(writer).includes(holder));
  });

  // Local classes by the class they extend, and the classes passed to a mixin, as A is in `class B extends Mixin(A)`.
  let subclassIndex = null;
  function descendants(cls) {
    if (!subclassIndex) {
      subclassIndex = { children: new Map(), mixed: new Set() };
      for (const sf of sourceFiles) {
        walk(sf, (n) => {
          const ext = ts.isClassLike(n) && n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
          if (!ext) return;
          const base = classOf(ext.expression);
          const call = unwrap(ext.expression);
          if (base) {
            if (!subclassIndex.children.has(base)) subclassIndex.children.set(base, []);
            subclassIndex.children.get(base).push(n);
          } else if (ts.isCallExpression(call)) for (const a of call.arguments) { const c = classOf(a); if (c) subclassIndex.mixed.add(c); }
        });
      }
    }
    const out = [];
    for (let i = -1, c = cls; i < out.length; c = out[++i]) {
      for (const child of subclassIndex.children.get(c) ?? []) if (!out.includes(child)) out.push(child);
    }
    return out;
  }
  // A subclass can replace a member, so one traced through its body or initializer is not followed when a
  // subclass in the scanned files declares the same name, or the class or a subclass is passed to a mixin.
  function overridden(cls, name, statics) {
    const below = descendants(cls);
    if ([cls, ...below].some((c) => subclassIndex.mixed.has(c))) return true;
    return below.some((c) => c.members.some((m) => m.name && memberKey(m.name) === name && isStatic(m) === statics) ||
      (!statics && parameterProperties(c).some((p) => p.name.text === name)));
  }

  // An object literal held in a variable or a default export escapes when a reference to it, in any scanned file,
  // does anything but read a property of it, export or import it, or name its type. Code it escapes to could change
  // it. A literal inside another literal escapes with it. A literal no name holds, such as one a function returns
  // or one stored in a field, is only checked for writes to the member.
  const escaped = new Map();
  function escapes(obj) {
    const p = outer(obj).parent;
    if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) return escapes(p.parent);
    let sym = null;
    let name = 'default';
    if (ts.isExportAssignment(p) && !p.isExportEquals) sym = checker.getSymbolAtLocation(p.getSourceFile())?.exports?.get('default');
    else {
      const id = ts.isVariableDeclaration(p) ? p.name : ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken ? unwrap(p.left) : null;
      if (!id || !ts.isIdentifier(id)) return false;
      sym = checker.getSymbolAtLocation(id);
      name = id.text;
    }
    if (!sym) return true;
    if (!escaped.has(sym)) escaped.set(sym, referencesOf(sym, name).some((ref) => !readOnly(ref)));
    return escaped.get(sym);
  }
  function readOnly(ref) {
    const use = outer(ts.isPropertyAccessExpression(ref.parent) && ref.parent.name === ref ? ref.parent : ref);
    const p = use.parent;
    if (ts.isVariableDeclaration(p) && p.name === ref) return true;
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isExportAssignment(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p)) return true;
    if (ts.isPropertyAccessExpression(p) && p.expression === use) return true;
    if (ts.isElementAccessExpression(p) && p.expression === use) return ts.isStringLiteralLike(p.argumentExpression) || (writeOf(p) === 'read' && !ts.isDeleteExpression(outer(p).parent));
    if (ts.isBinaryExpression(p) && p.left === use && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
    return false;
  }
  // Identifiers in the scanned files that refer to sym, also through imports, re-exports and a default export.
  function referencesOf(sym, name) {
    const names = new Set([name]);
    for (let size = 0; size !== names.size;) {
      size = names.size;
      for (const sf of sourceFiles) {
        for (const st of sf.statements) {
          if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression) && names.has(st.expression.text)) names.add('default');
          const clause = ts.isImportDeclaration(st) ? st.importClause : null;
          if (clause?.name && names.has('default')) names.add(clause.name.text);
          const bindings = clause?.namedBindings ?? (ts.isExportDeclaration(st) ? st.exportClause : null);
          if (!bindings || !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) continue;
          for (const el of bindings.elements) if (names.has((el.propertyName ?? el.name).text)) names.add(el.name.text);
        }
      }
    }
    const refs = [];
    for (const n of [...names].flatMap(identifiersNamed)) {
      let s = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
      if (s && s.flags & ts.SymbolFlags.Alias) {
        try { s = checker.getAliasedSymbol(s); } catch { s = null; }
      }
      if (s === sym) refs.push(n);
    }
    return refs;
  }
  // Every identifier in the scanned files by its text, found once.
  let identifierIndex = null;
  function identifiersNamed(name) {
    if (!identifierIndex) {
      identifierIndex = new Map();
      for (const sf of sourceFiles) {
        walk(sf, (n) => {
          if (!ts.isIdentifier(n)) return;
          if (!identifierIndex.has(n.text)) identifierIndex.set(n.text, []);
          identifierIndex.get(n.text).push(n);
        });
      }
    }
    return identifierIndex.get(name) ?? [];
  }

  // A type annotation that names a package export, such as `client: Acme`, `client: Acme | null` or
  // `client: acme.Client`, is read as an instance of it, and so is one that names a local class, such as `runner: Runner`.
  function fromTypeAnnotation(type, depth) {
    if (!type) return null;
    if (ts.isParenthesizedTypeNode(type)) return fromTypeAnnotation(type.type, depth);
    if (ts.isUnionTypeNode(type)) {
      const parts = type.types.filter((m) => !(ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword) && m.kind !== ts.SyntaxKind.UndefinedKeyword);
      return parts.length === 1 ? fromTypeAnnotation(parts[0], depth) : null;
    }
    if (!ts.isTypeReferenceNode(type)) return null;
    const names = [];
    let n = type.typeName;
    while (ts.isQualifiedName(n)) { names.unshift(n.right.text); n = n.left; }
    let base = fromSymbol(checker.getSymbolAtLocation(n), depth + 1);
    for (const name of names) base = base && extend(base, name, undefined, depth);
    if (base?.cls) return { inst: base.cls };
    return base?.module && isPackage(base.module) && !type.typeArguments?.length ? { module: base.module, root: 'instance', props: [] } : null;
  }

  // An untyped parameter of a local function, when every call to the function passes the same package
  // value. A function that is exported, or used other than by calling it, can have callers that are not
  // seen, so its parameters are not followed.
  function fromParameter(param, depth) {
    const typed = fromTypeAnnotation(param.type, depth);
    if (typed || param.type) return typed;
    const fn = param.parent;
    if (!param.dotDotDotToken && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(outer(fn).parent)) return fromCallback(param, fn, depth);
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

  // An untyped parameter of a function passed straight to a local function or method, as `({ cf })` is in
  // `runner.run(ctx, async ({ cf }) => ...)`, when every call that function makes to it passes the same value
  // and it never passes it on, stores it or reads it any other way.
  function fromCallback(param, fn, depth) {
    const call = outer(fn).parent;
    const k = call.arguments.indexOf(outer(fn));
    if (k < 0 || call.arguments.slice(0, k).some(ts.isSpreadElement)) return null;
    if (pendingParams.has(param)) return PENDING;
    pendingParams.add(param);
    try {
      const target = originOf(call.expression, depth + 1)?.fn;
      const slot = target?.body ? target.parameters[k] : null;
      if (!slot || !ts.isIdentifier(slot.name) || slot.dotDotDotToken) return null;
      const sym = checker.getSymbolAtLocation(slot.name);
      const index = fn.parameters.indexOf(param);
      const values = [];
      let escapes = !sym;
      walk(target, (n) => {
        if (escapes || n === slot.name || !ts.isIdentifier(n)) return;
        if (n.text === 'arguments' && !checker.getSymbolAtLocation(n)?.declarations?.length) { escapes = true; return; }
        if (n.text !== slot.name.text || checker.getSymbolAtLocation(n) !== sym) return;
        const use = outer(n);
        const c = use.parent;
        if (!ts.isCallExpression(c) || c.expression !== use || c.arguments.slice(0, index + 1).some(ts.isSpreadElement)) { escapes = true; return; }
        const arg = c.arguments[index];
        values.push(arg ? valueOf(arg, depth + 1) : param.initializer ? valueOf(param.initializer, depth + 1) : NULLISH);
      });
      return escapes || !values.length ? null : join(values);
    } finally {
      pendingParams.delete(param);
    }
  }

  function fromDeclaration(decl, depth) {
    if (ts.isFunctionDeclaration(decl)) return { fn: decl };
    if (ts.isClassDeclaration(decl)) return { cls: decl };
    if (ts.isParameter(decl)) return fromParameter(decl, depth);
    // A class field typed with the SDK class, or a readonly field initialised with the client that no subclass declares again.
    if (ts.isPropertyDeclaration(decl)) {
      const typed = fromTypeAnnotation(decl.type, depth);
      if (typed || decl.type) return typed;
      const readonly = (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly) !== 0;
      if (!readonly || !decl.initializer || overridden(decl.parent, memberKey(decl.name), isStatic(decl))) return null;
      return originOf(decl.initializer, depth + 1);
    }
    // A method or accessor, reached through `this.name`.
    if ((ts.isMethodDeclaration(decl) || ts.isAccessor(decl)) && (ts.isClassLike(decl.parent) || ts.isObjectLiteralExpression(decl.parent))) {
      return fromMember(decl.parent, memberKey(decl.name), isStatic(decl), depth);
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
      else if (ts.isParameter(holder)) base = fromParameter(holder, depth + 1);
      return base && extend(base, name, decl, depth);
    }
    if (ts.isExportAssignment(decl)) return originOf(decl.expression, depth + 1);
    // CommonJS: the property of a module.exports object, and `exports.client = ...` or `module.exports = ...`.
    // The property of any other object literal, reached through `this.name` in one of its methods.
    if ((ts.isShorthandPropertyAssignment(decl) || ts.isPropertyAssignment(decl)) && ts.isObjectLiteralExpression(decl.parent)) {
      return isExportsLiteral(decl.parent) ? fromObjectProperty(decl, depth) : fromMember(decl.parent, keyName(decl.name), false, depth);
    }
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
    if (ts.isClassExpression(node)) return { cls: node };
    if (ts.isObjectLiteralExpression(node)) return { obj: node };
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const m = thisMember(node);
      if (!m) return null;
      if (ts.isObjectLiteralExpression(m.parent)) return { obj: m.parent };
      return ts.isClassStaticBlockDeclaration(m) || isStatic(m) ? { cls: m.parent } : { inst: m.parent };
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.name) && isGlobalObject(node.expression)) return fromGlobalCache(node.name.text, depth + 1);
      // this.client inside a class: the member's declaration, or a constructor parameter property. Without
      // noImplicitThis the checker types `this` in an object literal's method as any, so the literal is found by position.
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const sym = checker.getSymbolAtLocation(node.name);
        if (sym?.declarations?.length) return fromSymbol(sym, depth + 1);
        const self = originOf(node.expression, depth + 1);
        return self?.obj ? extend(self, memberKey(node.name), undefined, depth) : null;
      }
      const base = originOf(node.expression, depth + 1);
      return base && ts.isIdentifier(node.name) ? extend(base, node.name.text, undefined, depth) : null;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const base = originOf(node.expression, depth + 1);
      return base && extend(base, node.argumentExpression.text, undefined, depth);
    }
    if (ts.isNewExpression(node)) {
      const base = originOf(node.expression, depth + 1);
      if (base?.cls) return { inst: base.cls };
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

  // Callers only ever see a package origin, a local value such as a function, module, class or object, or null, never the internal markers.
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

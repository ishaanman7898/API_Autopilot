import ts from 'typescript';
import { unwrap, fullPath } from './bindings.js';
import { walk } from './parse.js';

// Every string that names a module in import syntax: import, export from, require, import(), import = require, import type.
export function moduleRefs(sf, ctx) {
  const refs = [];
  walk(sf, (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
      refs.push({ node: n.moduleSpecifier, spec: n.moduleSpecifier.text });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)) {
      refs.push({ node: n.moduleReference.expression, spec: n.moduleReference.expression.text });
    } else if (ts.isCallExpression(n)) {
      const spec = ctx.moduleArg(n);
      if (spec !== null) refs.push({ node: n.arguments[0], spec });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteralLike(n.argument.literal)) {
      refs.push({ node: n.argument.literal, spec: n.argument.literal.text });
    }
  });
  return refs;
}

// import("x") types inside JSDoc comments, such as @param {import('x').Job}. TypeScript parses them in
// JavaScript and TypeScript files, so they are module names in syntax, not free text.
export function jsDocModuleRefs(sf) {
  const refs = [];
  const inDoc = (n) => {
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteralLike(n.argument.literal)) refs.push({ node: n.argument.literal, spec: n.argument.literal.text });
    ts.forEachChild(n, inDoc);
  };
  walk(sf, (n) => {
    for (const doc of n.jsDoc ?? []) ts.forEachChild(doc, inDoc);
  });
  return refs;
}

const isDefaultKey = (k) => (ts.isIdentifier(k) || ts.isStringLiteralLike(k)) && k.text === 'default';

// Places that take the default export of the module named exactly spec: import X from, import { default as X } from,
// export { default } from, and .default or a default key read from the module, as in (await import(spec)).default.
// With commonjs, for a module typed with `export =`, also require(spec), import X = require(spec) and import * as X
// from spec, since each of those takes the assigned value.
export function defaultImportSites(sf, ctx, spec, { commonjs = false } = {}) {
  const sites = [];
  const isDefault = (el) => (el.propertyName ?? el.name).text === 'default';
  const fromSpec = (n) => n && ts.isStringLiteralLike(n) && n.text === spec;
  const namespaceOf = (n) => {
    const o = ctx.originOf(n);
    return o?.module === spec && o.root === 'namespace' && o.props.length === 0;
  };
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && fromSpec(n.moduleSpecifier) && n.importClause) {
      const { name, namedBindings } = n.importClause;
      if (name) sites.push(name);
      if (namedBindings && ts.isNamedImports(namedBindings)) sites.push(...namedBindings.elements.filter(isDefault));
      if (commonjs && namedBindings && ts.isNamespaceImport(namedBindings)) sites.push(namedBindings);
    } else if (ts.isExportDeclaration(n) && fromSpec(n.moduleSpecifier) && n.exportClause && ts.isNamedExports(n.exportClause)) {
      sites.push(...n.exportClause.elements.filter(isDefault));
    } else if (commonjs && ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && fromSpec(n.moduleReference.expression)) {
      sites.push(n);
    } else if (commonjs && ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword && ctx.moduleArg(n) === spec) {
      sites.push(n);
    } else if ((ts.isPropertyAccessExpression(n) && n.name.text === 'default' && namespaceOf(n.expression)) ||
      (ts.isElementAccessExpression(n) && isDefaultKey(n.argumentExpression) && namespaceOf(n.expression))) {
      sites.push(n);
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && !n.dotDotDotToken && n.propertyName && isDefaultKey(n.propertyName)) {
      const holder = n.parent.parent;
      if (ts.isVariableDeclaration(holder) && holder.initializer && namespaceOf(holder.initializer)) sites.push(n);
    }
  });
  return sites;
}

// Files that import the package, or import other scanned files that do, at any depth.
// A lookalike call in one of these files is queued, because its receiver may come from the package.
export function filesReachingPackage(sourceFiles, checker, ctx) {
  const importers = new Map();
  const reach = new Set();
  for (const sf of sourceFiles) {
    for (const ref of moduleRefs(sf, ctx)) {
      if (ctx.isPackage(ref.spec)) { reach.add(sf.fileName); continue; }
      const target = checker.getSymbolAtLocation(ref.node)?.declarations?.[0];
      if (target && ts.isSourceFile(target)) importers.set(target.fileName, [...(importers.get(target.fileName) ?? []), sf.fileName]);
    }
  }
  const queue = [...reach];
  while (queue.length) {
    for (const f of importers.get(queue.pop()) ?? []) if (!reach.has(f)) { reach.add(f); queue.push(f); }
  }
  return reach;
}

// Property names along a callee such as a.b.c, ignoring the root expression.
export function propertyChain(callee) {
  const names = [];
  const bases = [];
  let node = callee;
  while (ts.isPropertyAccessExpression(node)) {
    if (!ts.isIdentifier(node.name)) return null;
    names.unshift(node.name);
    bases.unshift(node.expression);
    node = node.expression;
  }
  return { names, bases };
}

function tailMatches(callee, segs) {
  if (segs.length === 1 && ts.isIdentifier(callee)) return callee.text === segs[0];
  const chain = propertyChain(callee);
  if (!chain || chain.names.length < segs.length) return false;
  return segs.every((s, i) => chain.names[chain.names.length - segs.length + i].text === s);
}

const callsCache = new WeakMap();
const callsOf = (sf) => {
  if (!callsCache.has(sf)) {
    const calls = { call: [], new: [] };
    walk(sf, (n) => {
      if (ts.isCallExpression(n)) calls.call.push(n);
      else if (ts.isNewExpression(n)) calls.new.push(n);
    });
    callsCache.set(sf, calls);
  }
  return callsCache.get(sf);
};

// The path a call is matched by. default is the package's default export itself, which is also what require() gives
// a CommonJS package, so the client of import Acme from 'acme-sdk' and of require('acme-sdk') is new default.
const pathOf = (o) => (o.props.length === 0 && (o.root === 'default' || o.root === 'namespace') ? 'default' : fullPath(o).join('.'));

// Calls whose receiver is proven to come from the package, plus lookalike calls in files that reach it.
// A call path that starts with `new ` matches constructor calls instead, such as new Client({ ... }).
export function findCalls(ctx, sf, call) {
  const ctor = call.startsWith('new ');
  const path = ctor ? call.slice(4) : call;
  const segs = path.split('.');
  const importsPackage = ctx.reaches ? ctx.reaches.has(sf.fileName) : moduleRefs(sf, ctx).some((r) => ctx.isPackage(r.spec));
  const found = [];
  for (const n of callsOf(sf)[ctor ? 'new' : 'call']) {
    const callee = unwrap(n.expression);
    const origin = ctx.originOf(callee);
    if (origin?.module && ctx.isPackage(origin.module) && pathOf(origin) === path) {
      found.push({ node: n, callee, origin, proven: true });
    } else if (path !== 'default' && tailMatches(callee, segs)) {
      if (origin?.module && !ctx.isPackage(origin.module)) continue;
      // new Client() after import Client from 'acme-sdk' is traced, to an export that may or may not be Client.
      const other = ctor && origin?.module ? pathOf(origin) : null;
      const reason = other ? `${call} uses ${other === 'default' ? 'the default export' : other} of ${ctx.packageName}, which may not be ${path}` : `receiver of ${call} cannot be traced to ${ctx.packageName}`;
      if (importsPackage) found.push({ node: n, callee, origin, proven: false, reason });
    }
  }
  return found;
}

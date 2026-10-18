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
    const calls = [];
    walk(sf, (n) => { if (ts.isCallExpression(n)) calls.push(n); });
    callsCache.set(sf, calls);
  }
  return callsCache.get(sf);
};

// Calls whose receiver is proven to come from the package, plus lookalike calls in files that reach it.
export function findCalls(ctx, sf, call) {
  const segs = call.split('.');
  const importsPackage = ctx.reaches ? ctx.reaches.has(sf.fileName) : moduleRefs(sf, ctx).some((r) => ctx.isPackage(r.spec));
  const found = [];
  for (const n of callsOf(sf)) {
    const callee = unwrap(n.expression);
    const origin = ctx.originOf(callee);
    if (origin?.module && ctx.isPackage(origin.module) && fullPath(origin).join('.') === call) {
      found.push({ node: n, callee, origin, proven: true });
    } else if (tailMatches(callee, segs)) {
      if (origin?.module && !ctx.isPackage(origin.module)) continue;
      if (importsPackage) found.push({ node: n, callee, origin, proven: false, reason: `receiver of ${call} cannot be traced to ${ctx.packageName}` });
    }
  }
  return found;
}

import ts from 'typescript';
import { defaultImportSites, findCalls, jsDocModuleRefs, moduleRefs, propertyChain } from './match.js';
import { importTypeOf, unwrap } from './bindings.js';
import { walk } from './parse.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const keyText = (k) => (ts.isIdentifier(k) || ts.isStringLiteralLike(k) ? k.text : null);
const keyFor = (name) => (IDENT.test(name) ? name : JSON.stringify(name));

// Each transform receives an `out` with edit(sf, start, end, text, node) and fail(sf, node, reason).

export function renameImport(ctx, sf, rule, out) {
  const from = rule.match.module;
  const to = rule.transform.to;
  const matches = (s) => s === from || s.startsWith(from + '/');
  const inSyntax = new Set();
  for (const ref of [...moduleRefs(sf, ctx), ...jsDocModuleRefs(sf)]) {
    inSyntax.add(ref.node);
    if (!matches(ref.spec)) continue;
    const start = ref.node.getStart(sf) + 1;
    const end = ref.node.getEnd() - 1;
    if (sf.text.slice(start, end) !== ref.spec) out.fail(sf, ref.node, 'module specifier uses escape sequences');
    else out.edit(sf, start, end, to + ref.spec.slice(from.length), ref.node);
  }
  walk(sf, (n) => {
    if (ts.isStringLiteralLike(n) && matches(n.text) && !inSyntax.has(n)) out.fail(sf, n, `module name ${n.text} appears outside import syntax`);
  });
}

// Renames a binding's imported name while keeping the local name, so no reference needs to change.
function renameSite(sf, site, to, out, node) {
  const file = site.getSourceFile();
  if (!IDENT.test(to)) return out.fail(sf, node, `cannot rename binding to ${to}`);
  if (ts.isImportSpecifier(site) || ts.isExportSpecifier(site)) {
    if (site.propertyName) out.edit(file, site.propertyName.getStart(file), site.propertyName.getEnd(), to, node);
    else out.edit(file, site.getStart(file), site.getEnd(), `${to} as ${site.name.text}`, node);
  } else if (ts.isBindingElement(site)) {
    if (site.propertyName) out.edit(file, site.propertyName.getStart(file), site.propertyName.getEnd(), to, node);
    else out.edit(file, site.name.getStart(file), site.name.getEnd(), `${to}: ${site.name.text}`, node);
  } else out.fail(sf, node, 'binding kind cannot be renamed safely');
}

export function renameMethod(ctx, sf, rule, out) {
  const { call } = rule.match;
  const to = rule.transform.to;
  const segs = call.split('.');
  for (const c of findCalls(ctx, sf, call)) {
    if (!c.proven) { out.fail(sf, c.node, c.reason); continue; }
    const chain = propertyChain(c.callee);
    const first = chain ? chain.names.length - segs.length : -1;
    const base = first >= 0 ? ctx.originOf(chain.bases[first]) : null;
    const rootOk = base?.module && base.root !== 'named' && base.props.length === 0;
    if (rootOk) {
      const start = chain.names[first].getStart(sf);
      const end = chain.names.at(-1).getEnd();
      if (!/^[\w$\s.]+$/.test(sf.text.slice(start, end))) out.fail(sf, c.node, 'comments or optional chaining inside the call path');
      else out.edit(sf, start, end, to, c.node);
    } else if (segs.length === 1 && c.origin.site) renameSite(sf, c.origin.site, to, out, c.node);
    else out.fail(sf, c.node, 'call path crosses a variable binding or a named import');
  }
}

export function renameParam(ctx, sf, rule, out) {
  const { call, param } = rule.match;
  const argIndex = rule.match.arg ?? 0;
  const to = rule.transform.to;
  for (const c of findCalls(ctx, sf, call)) {
    if (!c.proven) { out.fail(sf, c.node, c.reason); continue; }
    const arg = c.node.arguments[argIndex];
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      if (arg) out.fail(sf, c.node, `argument ${argIndex} of ${call} is not an object literal`);
      continue;
    }
    let hit = false;
    let opaque = false;
    for (const p of arg.properties) {
      if (ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) { opaque = true; continue; }
      if (!p.name || keyText(p.name) !== param) continue;
      hit = true;
      if (ts.isShorthandPropertyAssignment(p)) out.edit(sf, p.name.getStart(sf), p.name.getEnd(), `${to}: ${param}`, c.node);
      else if (ts.isStringLiteralLike(p.name)) out.edit(sf, p.name.getStart(sf) + 1, p.name.getEnd() - 1, to, c.node);
      else out.edit(sf, p.name.getStart(sf), p.name.getEnd(), to, c.node);
    }
    if (!hit && opaque) out.fail(sf, c.node, `${call} argument has spread or computed keys that may contain ${param}`);
  }
}

// Values that cannot carry an options key: literals, templates and arrays.
const keyless = (n) => ts.isLiteralExpression(n) || ts.isTemplateExpression(n) || ts.isArrayLiteralExpression(n) ||
  [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(n.kind) || (ts.isIdentifier(n) && n.text === 'undefined');

// Renames a key of an options object, such as zod 4's { message } to { error }, or a client option in
// new Client({ ... }) with match.call 'new Client', or 'new default' for the default export. Only a plain, quoted or
// shorthand key in an object literal is renamed: { message } becomes { error: message }. An argument that may hold
// the key where the engine cannot see it, or an object that already has the new key, is queued. A lookalike call
// is queued only when its argument would have been rewritten or queued.
export function renameOption(ctx, sf, rule, out) {
  const { call, arg: index, key } = rule.match;
  const { to } = rule.transform;
  const where = `argument ${index} of ${call}`;
  for (const c of findCalls(ctx, sf, call)) {
    const arg = c.node.arguments?.[index];
    const value = arg && unwrap(arg);
    if (!value || keyless(value)) continue;
    let problem = ts.isObjectLiteralExpression(value) ? null : `${where} is not an object literal`;
    const hits = [];
    let taken = false;
    for (const p of problem ? [] : value.properties) {
      if (ts.isSpreadAssignment(p)) problem ??= `${where} spreads an object that may hold ${key}`;
      else if (ts.isComputedPropertyName(p.name)) problem ??= `${where} has a computed key that may be ${key}`;
      else if (keyText(p.name) === to) taken = true;
      else if (keyText(p.name) !== key) continue;
      else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) hits.push(p);
      else problem ??= `${key} in ${where} is a method or accessor`;
    }
    if (!problem && taken && hits.length) problem = `${where} already has ${to}`;
    if (!problem && !hits.length) continue;
    if (!c.proven) out.fail(sf, c.node, c.reason);
    else if (problem) out.fail(sf, c.node, problem);
    else {
      for (const p of hits) {
        const start = p.name.getStart(sf);
        const q = sf.text[start];
        const name = ts.isStringLiteral(p.name) && IDENT.test(to) ? q + to + q : keyFor(to);
        out.edit(sf, start, p.name.getEnd(), ts.isShorthandPropertyAssignment(p) ? `${name}: ${p.name.text}` : name, c.node);
      }
    }
  }
}

// One segment of a dotted name and what comes before it: a property access in code, a qualified name in a
// type such as Acme.Jobs.Job, or the first name after an import('x') type, whose base is the import itself.
function segmentOf(n) {
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) return { name: n.name, base: n.expression };
  if (ts.isQualifiedName(n)) return { name: n.right, base: n.left };
  const holder = ts.isIdentifier(n) ? importTypeOf(n) : null;
  return holder ? { name: n, base: holder } : null;
}

// The type position a qualified name or import('x') type sits in: a type reference, typeof, or import X = A.B.
// A name inside a JSDoc @link, or inside an expression, is not one.
function typePosition(n) {
  while (ts.isQualifiedName(n.parent) || (ts.isImportTypeNode(n.parent) && n.parent.qualifier === n)) n = n.parent;
  const p = n.parent;
  if (ts.isTypeQueryNode(p)) return 'typeof';
  if (ts.isImportTypeNode(n)) return n.isTypeOf ? 'typeof' : 'type';
  return ts.isTypeReferenceNode(p) || ts.isImportEqualsDeclaration(p) ? 'type' : null;
}

// Renames a property path such as robotsPreview to robots wherever it follows a proven package value,
// in calls and in plain reads, so one rule moves a whole resource. The same path is renamed in type names,
// such as Acme.RobotsPreview.Job, typeof client.robotsPreview and import('acme-sdk').RobotsPreview, and in
// JSDoc types. A one-segment path in destructuring, or imported by name from the package, is renamed with
// the local name kept. The same path on something that cannot be proven is queued in files that reach the
// package, and the same path on another package, or on a type the files declare themselves, is left alone.
export function renameNamespace(ctx, sf, rule, out) {
  const { path } = rule.match;
  const segs = path.split('.');
  const to = rule.transform.to;
  const reaches = ctx.reaches ? ctx.reaches.has(sf.fileName) : moduleRefs(sf, ctx).some((r) => ctx.isPackage(r.spec));
  const rooted = (o) => o?.module && ctx.isPackage(o.module) && o.root !== 'named' && o.props.length === 0;
  const unknown = (o) => !o?.module;
  const leftmost = (n) => (ts.isQualifiedName(n) ? leftmost(n.left) : n);
  const visit = (n) => {
    const last = segmentOf(n);
    if (last && last.name.text === segs.at(-1)) {
      let node = n;
      const names = [];
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segmentOf(node);
        if (!s || s.name.text !== segs[i]) return;
        names.unshift(s.name);
        node = s.base;
      }
      const inType = ts.isPropertyAccessExpression(n) ? null : typePosition(n);
      if (!ts.isPropertyAccessExpression(n) && !inType) return;
      const origin = ctx.originOf(node);
      if (rooted(origin)) {
        const start = names[0].getStart(sf);
        const end = names.at(-1).getEnd();
        if (!/^[\w$\s.]+$/.test(sf.text.slice(start, end))) out.fail(sf, n, `comments or optional chaining inside ${path}`);
        else out.edit(sf, start, end, to, n);
      } else if (inType && origin?.module && ctx.isPackage(origin.module) && origin.root === 'named' && origin.props.length === 0) {
        out.fail(sf, n, `type name ${path} follows ${node.getText(sf)}, which is imported by name from ${origin.module} and may not be the client`);
      } else if (unknown(origin) && reaches) {
        // A type the scanned files declare, such as a local namespace with the same member, is not the package's.
        if (inType === 'type' && !ts.isImportTypeNode(node) && ctx.declaredHere(leftmost(node))) return;
        out.fail(sf, n, inType ? `type name ${path} cannot be traced to ${ctx.packageName}` : `receiver of ${path} cannot be traced to ${ctx.packageName}`);
      }
      return;
    }
    // import { RobotsPreview } from 'acme-sdk/resources' becomes import { Robots as RobotsPreview }, and the same in export from.
    if (segs.length === 1 && (ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && keyText(n.propertyName ?? n.name) === path) {
      const spec = (ts.isImportSpecifier(n) ? n.parent.parent.parent : n.parent.parent).moduleSpecifier;
      if (!spec || !ts.isStringLiteralLike(spec) || !ctx.isPackage(spec.text)) return;
      if (!IDENT.test(to)) out.fail(sf, n, `${path} cannot be renamed to ${to} in an import`);
      else if (n.propertyName && ts.isIdentifier(n.propertyName)) out.edit(sf, n.propertyName.getStart(sf), n.propertyName.getEnd(), to, n);
      else if (!n.propertyName && ts.isIdentifier(n.name)) out.edit(sf, n.name.getStart(sf), n.name.getEnd(), `${to} as ${n.name.text}`, n);
      else out.fail(sf, n, `${path} is imported with a quoted name`);
      return;
    }
    if (segs.length === 1 && ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && !n.dotDotDotToken && keyText(n.propertyName ?? n.name) === path) {
      const holder = n.parent.parent;
      const origin = ts.isVariableDeclaration(holder) && holder.initializer ? ctx.originOf(holder.initializer) : null;
      if (rooted(origin) && IDENT.test(to)) {
        if (n.propertyName && ts.isIdentifier(n.propertyName)) out.edit(sf, n.propertyName.getStart(sf), n.propertyName.getEnd(), to, n);
        else if (!n.propertyName && ts.isIdentifier(n.name)) out.edit(sf, n.name.getStart(sf), n.name.getEnd(), `${to}: ${n.name.text}`, n);
        else out.fail(sf, n, `${path} is destructured with a quoted or computed key`);
      } else if (rooted(origin)) out.fail(sf, n, `${path} cannot be renamed to ${to} in destructuring`);
      else if (unknown(origin) && reaches) out.fail(sf, n, `receiver of ${path} cannot be traced to ${ctx.packageName}`);
    }
  };
  walk(sf, (n) => {
    visit(n);
    for (const doc of n.jsDoc ?? []) ts.forEachChild(doc, (c) => walk(c, visit));
  });
}

// An argument that can be moved without changing what runs: names, literals and property reads of them.
function isSimple(n) {
  while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n)) n = n.expression;
  if (ts.isIdentifier(n) || ts.isLiteralExpression(n) || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPropertyAccessExpression(n)) return isSimple(n.expression);
  if (ts.isTemplateExpression(n)) return n.templateSpans.every((s) => isSimple(s.expression));
  return false;
}

// Moves the first positional arguments of a call into its params object, as when an SDK switches to named
// path parameters: retrieve('p_123', 'c_456') becomes retrieve('c_456', { parent_id: 'p_123' }).
// match.positional is how many positional arguments the old signature takes, and transform.names are the
// keys the first of them move to. A call already in the new shape is left alone.
export function positionalToNamed(ctx, sf, rule, out) {
  const { call, positional } = rule.match;
  const { names } = rule.transform;
  const keep = positional - names.length;
  for (const c of findCalls(ctx, sf, call)) {
    if (!c.proven) { out.fail(sf, c.node, c.reason); continue; }
    const args = c.node.arguments;
    if (args.some(ts.isSpreadElement)) { out.fail(sf, c.node, `${call} is called with a spread argument`); continue; }
    const migrated = args[keep] && ts.isObjectLiteralExpression(args[keep]) && args[keep].properties.some((p) => p.name && names.includes(keyText(p.name)));
    if (migrated) continue;
    if (args.length < positional || args.slice(0, positional).some(ts.isObjectLiteralExpression)) {
      out.fail(sf, c.node, `${call} is not called with ${positional} positional arguments`);
      continue;
    }
    const moved = args.slice(0, names.length);
    const kept = args.slice(names.length, positional);
    if (![...moved, ...kept].every(isSimple)) { out.fail(sf, c.node, `arguments of ${call} could have side effects and moving them would change their order`); continue; }
    const params = args[positional];
    if (params && ts.isObjectLiteralExpression(params) && params.properties.some((p) => p.name && names.includes(keyText(p.name)))) {
      out.fail(sf, c.node, `the params object of ${call} already has one of ${names.join(', ')}`);
      continue;
    }
    const text = (n) => sf.text.slice(n.getStart(sf), n.getEnd());
    const pairs = names.map((n, i) => `${keyFor(n)}: ${text(moved[i])}`).join(', ');
    let object;
    if (!params) object = `{ ${pairs} }`;
    else if (ts.isObjectLiteralExpression(params)) {
      // Keeps the object's own layout: a multi-line object gets the new keys on its first line.
      const inner = sf.text.slice(params.getStart(sf) + 1, params.getEnd() - 1);
      if (!inner.trim()) object = `{ ${pairs} }`;
      else object = inner.includes('\n') ? `{ ${pairs},${inner}}` : `{ ${pairs}, ${inner.trim()} }`;
    } else object = `{ ${pairs}, ...${text(params)} }`;
    const end = (params ?? args[positional - 1]).getEnd();
    out.edit(sf, args[0].getStart(sf), end, [...kept.map(text), object].join(', '), c.node);
  }
}

// Queues every call that matches, or with match.import 'default' every place that takes the default export of
// match.module, which is the package root unless the rule names a subpath.
export function flagManual(ctx, sf, rule, out) {
  if (rule.match.import === 'default') {
    for (const n of defaultImportSites(sf, ctx, rule.match.module ?? ctx.packageName, { commonjs: rule.match.commonjs === true })) out.fail(sf, n, 'manual rule: default import needs a migration');
    return;
  }
  for (const c of findCalls(ctx, sf, rule.match.call)) out.fail(sf, c.node, c.proven ? 'manual rule: call site needs a migration' : c.reason);
}

export const TRANSFORMS = {
  'rename-import': renameImport,
  'rename-method': renameMethod,
  'rename-param': renameParam,
  'rename-option': renameOption,
  'rename-namespace': renameNamespace,
  'positional-to-named': positionalToNamed,
  manual: flagManual,
};

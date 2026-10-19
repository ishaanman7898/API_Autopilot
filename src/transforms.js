import ts from 'typescript';
import { defaultImportSites, findCalls, jsDocModuleRefs, moduleRefs, pathOf, propertyChain } from './match.js';
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

// rename-param is rename-option on argument match.arg, 0 by default, with match.param as the key, so a spread
// next to the key or an object that already has the new key is queued, not renamed.
export function renameParam(ctx, sf, rule, out) {
  const { call, param, arg = 0 } = rule.match;
  renameOption(ctx, sf, { ...rule, match: { call, arg, key: param } }, out);
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

const isAssertion = (n) => ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n);
const COMMENT = /\/[/*]/;

// The expression inside parentheses and type assertions, and the assertions from the outermost in.
function peel(n) {
  const casts = [];
  while (n && (ts.isParenthesizedExpression(n) || isAssertion(n))) {
    if (isAssertion(n)) casts.push(n);
    n = n.expression;
  }
  return { value: n, casts };
}

// A params argument that is a name, this, or a property read of them, so spreading it runs nothing.
function isRead(n) {
  while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
  if (ts.isIdentifier(n) || n.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(n)) return isRead(n.expression);
  if (ts.isElementAccessExpression(n)) return isRead(n.expression) && (ts.isLiteralExpression(n.argumentExpression) || ts.isIdentifier(n.argumentExpression));
  return false;
}

const LOGICAL = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];
// An expression whose evaluation runs nothing: a simple argument, a read, a function, a choice between such
// expressions, or object and array literals of them.
function isPure(n) {
  while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || isAssertion(n)) n = n.expression;
  if (isSimple(n) || isRead(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return true;
  if (ts.isConditionalExpression(n)) return isPure(n.condition) && isPure(n.whenTrue) && isPure(n.whenFalse);
  if (ts.isBinaryExpression(n) && LOGICAL.includes(n.operatorToken.kind)) return isPure(n.left) && isPure(n.right);
  if (ts.isArrayLiteralExpression(n)) return n.elements.every((e) => isPure(ts.isSpreadElement(e) ? e.expression : e));
  if (ts.isObjectLiteralExpression(n)) return n.properties.every(isPureProperty);
  return false;
}
const isPureProperty = (p) => (!p.name || !ts.isComputedPropertyName(p.name) || isPure(p.name.expression)) &&
  (ts.isPropertyAssignment(p) ? isPure(p.initializer) : ts.isSpreadAssignment(p) ? isPure(p.expression) : true);

// Parameters<typeof X> in code and in JSDoc, with the index literal of Parameters<typeof X>[N], or null when there is no number index.
// Source files are reused between rules until a rule edits them, so each node's answer is kept.
const refsOf = new WeakMap();
function parametersRefs(root) {
  if (refsOf.has(root)) return refsOf.get(root);
  const refs = [];
  const visit = (n) => {
    if (ts.isTypeQueryNode(n)) {
      let ref = n.parent;
      while (ts.isParenthesizedTypeNode(ref)) ref = ref.parent;
      if (ts.isTypeReferenceNode(ref) && ts.isIdentifier(ref.typeName) && ref.typeName.text === 'Parameters' && ref.typeArguments?.length === 1) {
        const access = ref.parent;
        const indexed = ts.isIndexedAccessTypeNode(access) && access.objectType === ref && ts.isLiteralTypeNode(access.indexType) && ts.isNumericLiteral(access.indexType.literal);
        refs.push({ node: n, index: indexed ? access.indexType.literal : null });
      }
    }
    ts.forEachChild(n, visit);
    for (const doc of n.jsDoc ?? []) ts.forEachChild(doc, visit);
  };
  visit(root);
  refsOf.set(root, refs);
  return refs;
}

// Whether a file mentions Parameters< at all. Asked once per file, not once per rule.
const mentionsOf = new WeakMap();
const mentionsParameters = (sf) => {
  if (!mentionsOf.has(sf)) mentionsOf.set(sf, /Parameters\s*</.test(sf.text));
  return mentionsOf.get(sf);
};

// Whether the dotted name ends with the call's path, such as c.parents.children.retrieve for parents.children.retrieve.
function endsWithPath(e, segs) {
  let i = segs.length - 1;
  for (; i > 0 && ts.isQualifiedName(e) && e.right.text === segs[i]; i--) e = e.left;
  return i === 0 && (ts.isQualifiedName(e) ? e.right.text === segs[0] : ts.isIdentifier(e) && e.text === segs[0]);
}

const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike;
const UNTYPED = [ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword];

// Moves the first positional arguments of a call into its params object, as when an SDK switches to named
// path parameters: retrieve('p_123', 'c_456') becomes retrieve('c_456', { parent_id: 'p_123' }).
// match.positional is how many positional arguments the old signature takes, and transform.names are the
// keys the first of them move to. A call already in the new shape is left alone. The moved values must still
// win over a spread or a computed key, so the new keys go after the last one, and the call is queued when
// anything before them could run code and a moved value could change. Another params argument is spread when
// it is a name or a property read, and queued when it may not be an object. One with a type assertion keeps it
// and is spread, and one with a satisfies check is queued. Parameters<typeof <call>>[N] in the call's arguments
// is shifted to the new positions, and Parameters<typeof <call>> anywhere else in the file is queued, because
// its positions changed too.
export function positionalToNamed(ctx, sf, rule, out) {
  const { call, positional } = rule.match;
  // Most files have no call of the method and no Parameters, so nothing below is set up for them.
  const calls = findCalls(ctx, sf, call);
  const hasRefs = mentionsParameters(sf);
  if (!calls.length && !hasRefs) return;
  const { names } = rule.transform;
  const keep = positional - names.length;
  const segs = call.split('.');
  const { checker } = ctx;
  const text = (n) => sf.text.slice(n.getStart(sf), n.getEnd());
  const flat = (n) => text(n).replace(/\s+/g, '');
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const named = (p) => p.name && (names.includes(keyText(p.name)) || (ts.isComputedPropertyName(p.name) && ts.isStringLiteralLike(p.name.expression) && names.includes(p.name.expression.text)));
  const hasName = (n) => n && ts.isObjectLiteralExpression(n) && n.properties.some(named);
  const proven = (n) => {
    const o = ctx.originOf(n);
    return o?.module && ctx.isPackage(o.module) && pathOf(o) === call;
  };
  // A typeof that can name the method ends with its name, or is one name, such as a renamed import. Others are not traced.
  const method = segs.at(-1);
  const candidate = (e) => (ts.isQualifiedName(e) ? e.right.text === method : ts.isIdentifier(e));
  const nothing = (n) => n.kind === ts.SyntaxKind.NullKeyword || (ts.isVoidExpression(n) && ts.isNumericLiteral(n.expression)) ||
    (ts.isIdentifier(n) && n.text === 'undefined' && !checker.getSymbolAtLocation(n)?.declarations?.length);
  const isPrimitive = (t) => {
    if (t.flags & ts.TypeFlags.TypeParameter) t = checker.getBaseConstraintOfType(t) ?? t;
    return t.isUnion() || t.isIntersection() ? t.types.some(isPrimitive) : (t.flags & PRIMITIVE) !== 0;
  };
  // A name may hold a string where the engine cannot see it, since it has no lib types. When the checker types it as
  // any, its declaration decides: a call, a template or an operator may give a string, such as const body =
  // JSON.stringify(data). Variables, parameter defaults, destructured names, imports and default exports are followed,
  // and a name declared from another name too.
  const mayBePrimitive = (n, depth = 0) => {
    const t = checker.getTypeAtLocation(n);
    if (isPrimitive(t)) return true;
    if (!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return false;
    while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    let sym = ts.isIdentifier(n) ? checker.getSymbolAtLocation(n) : null;
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.find(ts.isExportAssignment);
    let source = null;
    if (decl && ts.isExportAssignment(decl)) source = decl.expression;
    else if (decl && (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl))) {
      if (decl.type && !UNTYPED.includes(decl.type.kind)) return false;
      source = decl.initializer;
      // const { body } = <source> reads body from the source, which may be a literal that names it.
      if (!source && ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) && ts.isVariableDeclaration(decl.parent.parent) && decl.parent.parent.initializer) {
        const from = peel(decl.parent.parent.initializer).value;
        const key = keyText(decl.propertyName ?? decl.name);
        const prop = ts.isObjectLiteralExpression(from) ? from.properties.find((p) => p.name && keyText(p.name) === key) : null;
        source = prop && ts.isPropertyAssignment(prop) ? prop.initializer : ts.isObjectLiteralExpression(from) ? null : from;
        if (source === from && (isRead(from) || ts.isNewExpression(from))) return false;
      }
    }
    if (!source) return false;
    const init = peel(source);
    if (init.casts.some((a) => !UNTYPED.includes(a.type.kind))) return false;
    let value = init.value;
    while (ts.isNonNullExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
    if (ts.isIdentifier(value)) return depth < 3 ? mayBePrimitive(value, depth + 1) : true;
    return !ts.isObjectLiteralExpression(value) && !ts.isNewExpression(value) && !isRead(value);
  };
  // Edits that shift Parameters<typeof <call>>[N] in an argument to N - names.length, or the reason they cannot.
  // typeof of the call's own callee, such as typeof this.client.x.get inside this.client.x.get(...), names the proven
  // method. A ref inside a proven call of the method nested in this one belongs to that call.
  const shifts = (node, c) => {
    const edits = [];
    for (const r of hasRefs ? parametersRefs(node) : []) {
      if (!candidate(r.node.exprName)) continue;
      const inside = (n, o) => n.pos >= o.node.pos && n.end <= o.node.end;
      if (calls.some((o) => o !== c && o.proven && inside(o.node, c) && inside(r.node, o))) continue;
      const same = flat(r.node.exprName) === flat(c.callee) || proven(r.node.exprName);
      const other = ctx.originOf(r.node.exprName)?.module;
      if (!same && (!endsWithPath(r.node.exprName, segs) || (other && !ctx.isPackage(other)))) continue;
      if (!same) return { problem: `Parameters<typeof ${text(r.node.exprName)}> in the arguments of ${call} cannot be traced to ${ctx.packageName}` };
      if (!r.index) return { problem: `Parameters<typeof ${call}> in the arguments of ${call} has no number index` };
      const n = Number(r.index.text);
      if (n < names.length) return { problem: `Parameters<typeof ${call}>[${n}] in the arguments of ${call} names an argument that moves into the params object` };
      edits.push({ start: r.index.getStart(sf), end: r.index.getEnd(), text: String(n - names.length) });
    }
    return { edits };
  };
  const withEdits = (node, edits) => {
    let t = text(node);
    for (const e of [...edits].sort((a, b) => b.start - a.start)) t = t.slice(0, e.start - node.getStart(sf)) + e.text + t.slice(e.end - node.getStart(sf));
    return t;
  };
  // A literal, or a name bound by const or an import, keeps its value whatever runs before it is read.
  const isConstant = (n) => {
    while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || isAssertion(n)) n = n.expression;
    if (ts.isLiteralExpression(n) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(n.kind)) return true;
    const decl = ts.isIdentifier(n) ? checker.getSymbolAtLocation(n)?.declarations?.[0] : null;
    return Boolean(decl && (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl) ||
      ((ts.isVariableDeclaration(decl) || ts.isBindingElement(decl)) && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)));
  };
  // A read whose type, as far as the engine can see it, has one of the new keys may be the new shape's params.
  const typedNew = (n) => n && isRead(n) && names.some((k) => checker.getTypeAtLocation(n).getProperty(k));
  for (const c of calls) {
    if (!c.proven) { out.fail(sf, c.node, c.reason); continue; }
    const args = c.node.arguments;
    if (args.some(ts.isSpreadElement)) { out.fail(sf, c.node, `${call} is called with a spread argument`); continue; }
    if (hasName(args[keep] && peel(args[keep]).value)) continue;
    if (typedNew(args[keep] && peel(args[keep]).value)) { out.fail(sf, c.node, `argument ${keep} of ${call} is typed with one of ${names.join(', ')}, so the call may already be in the new shape`); continue; }
    if (args.length < positional || args.slice(0, positional).some((a) => ts.isObjectLiteralExpression(peel(a).value))) {
      out.fail(sf, c.node, `${call} is not called with ${positional} positional arguments`);
      continue;
    }
    const moved = args.slice(0, names.length);
    const kept = args.slice(names.length, positional);
    if (![...moved, ...kept].every(isSimple)) { out.fail(sf, c.node, `arguments of ${call} could have side effects and moving them would change their order`); continue; }
    const params = args[positional];
    const start = args[0].getStart(sf);
    const end = (params ?? args[positional - 1]).getEnd();
    let { value, casts } = params ? peel(params) : { value: null, casts: [] };
    if (value && nothing(value)) {
      value = null;
      casts = [];
    }
    const spread = value && (casts.length > 0 || !ts.isObjectLiteralExpression(value));
    // The arguments are rebuilt from their own text, so a comment before the first, between them, or around a params
    // object that is merged or dropped would be lost or land on another argument.
    const gaps = [sf.text.slice(args.pos, start), ...args.slice(1, positional + (params ? 1 : 0)).map((a, i) => sf.text.slice(args[i].getEnd(), a.getStart(sf)))];
    if (params && !spread) gaps.push(value ? text(params).replace(text(value), '') : text(params));
    if (gaps.some((g) => COMMENT.test(g))) { out.fail(sf, c.node, `comments around the arguments of ${call} would be lost`); continue; }
    if (calls.some((o) => o !== c && o.node.getStart(sf) >= start && o.node.getEnd() <= end)) { out.fail(sf, c.node, `${call} is called again inside its own arguments`); continue; }
    if (casts.some(ts.isSatisfiesExpression)) { out.fail(sf, c.node, `the params argument of ${call} has a satisfies check, which the moved keys would change`); continue; }
    if (hasName(value)) { out.fail(sf, c.node, `the params object of ${call} already has one of ${names.join(', ')}`); continue; }
    if (value && !ts.isObjectLiteralExpression(value)) {
      if (!isRead(value)) { out.fail(sf, c.node, `the params argument of ${call} is not an object literal, a name or a property read, so it cannot be spread`); continue; }
      if (mayBePrimitive(value)) { out.fail(sf, c.node, `the params argument of ${call} may not be an object, so it cannot be spread`); continue; }
    }
    // An asserted object is spread rather than merged, so its assertion still checks only what the caller wrote.
    const props = value && !spread ? value.properties : [];
    const last = props.findLastIndex((p) => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name)));
    // The moved values were read first, so anything that now runs before them must not run code, unless they cannot change.
    if (!moved.every(isConstant) && (spread ? !isPure(value) : !props.slice(0, last + 1).every(isPureProperty))) { out.fail(sf, c.node, `arguments of ${call} could have side effects and moving them would change their order`); continue; }
    if (moved.some((m) => { const s = shifts(m, c); return s.problem || s.edits.length; })) {
      out.fail(sf, c.node, `Parameters<typeof ${call}> in an argument of ${call} that moves into the params object cannot be shifted`);
      continue;
    }
    const shift = [...kept, ...(value ? [spread ? params : value] : []), ...args.slice(positional + 1)].map((a) => shifts(a, c));
    const problem = shift.find((s) => s.problem)?.problem;
    if (problem) { out.fail(sf, c.node, problem); continue; }
    const paramEdits = value ? shift[kept.length].edits : [];
    const pairs = names.map((n, i) => `${keyFor(n)}: ${text(moved[i])}`).join(', ');
    let object;
    if (!value) object = `{ ${pairs} }`;
    else if (spread) object = `{ ...${isAssertion(params) ? `(${withEdits(params, paramEdits)})` : withEdits(params, paramEdits)}, ${pairs} }`;
    else if (last < 0) {
      // Keeps the object's own layout: a multi-line object gets the new keys on its first line.
      const inner = withEdits(value, paramEdits).slice(1, -1);
      object = !inner.trim() ? `{ ${pairs} }` : inner.includes('\n') ? `{ ${pairs},${inner}}` : `{ ${pairs}, ${inner.trim()} }`;
    } else {
      // The new keys go after the last spread or computed key, its comma, and a comment that ends its line, on a line
      // of their own indented like the next property, or on the same line when the next property shares it.
      const at = props[last];
      const isLast = last === props.length - 1;
      const comma = !isLast || props.hasTrailingComma;
      const multi = text(value).includes('\n') && (isLast || lineOf(props[last + 1].getStart(sf)) !== lineOf(at.getEnd()));
      const nl = text(value).includes('\r\n') ? '\r\n' : '\n';
      const indent = sf.text.slice(sf.text.lastIndexOf('\n', (isLast ? at : props[last + 1]).getStart(sf)) + 1).match(/^[ \t]*/)[0];
      const after = comma ? ts.skipTrivia(sf.text, at.getEnd()) + 1 : at.getEnd();
      const comments = multi ? ts.getTrailingCommentRanges(sf.text, after) ?? [] : [];
      const pos = comments.length ? comments.at(-1).end : after;
      const added = multi ? `${nl}${indent}${pairs}${comma ? ',' : ''}` : ` ${pairs}${isLast ? '' : ','}`;
      const edits = comma ? [{ start: pos, end: pos, text: added }]
        : pos === after ? [{ start: pos, end: pos, text: `,${added}` }] : [{ start: after, end: after, text: ',' }, { start: pos, end: pos, text: added }];
      object = withEdits(value, [...paramEdits, ...edits]);
    }
    out.edit(sf, start, end, [...kept.map((k, i) => withEdits(k, shift[i].edits)), object].join(', '), c.node);
    for (const s of shift.slice(kept.length + (value ? 1 : 0))) for (const e of s.edits) out.edit(sf, e.start, e.end, e.text, c.node);
  }
  if (!hasRefs) return;
  const reaches = ctx.reaches ? ctx.reaches.has(sf.fileName) : moduleRefs(sf, ctx).some((r) => ctx.isPackage(r.spec));
  // Every call of the method was rewritten with its Parameters shifted, left alone in the new shape, or queued.
  for (const r of parametersRefs(sf)) {
    if (!candidate(r.node.exprName)) continue;
    if (calls.some((c) => r.node.pos >= c.node.arguments.pos && r.node.end <= c.node.arguments.end)) continue;
    const o = ctx.originOf(r.node.exprName);
    const ours = o?.module && ctx.isPackage(o.module) && pathOf(o) === call;
    if (ours || (endsWithPath(r.node.exprName, segs) && (o?.module ? ctx.isPackage(o.module) : reaches))) out.fail(sf, r.node, `Parameters<typeof ${call}> may use the old argument positions of ${call}`);
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

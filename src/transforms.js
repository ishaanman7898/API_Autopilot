import ts from 'typescript';
import { findCalls, jsDocModuleRefs, moduleRefs, propertyChain } from './match.js';
import { walk } from './parse.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const keyText = (k) => (ts.isIdentifier(k) || ts.isStringLiteralLike(k) ? k.text : null);

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

// Renames a property path such as robotsPreview to robots wherever it follows a proven package value,
// in calls and in plain reads, so one rule moves a whole resource. A one-segment path in destructuring is
// renamed with the local name kept. The same path on something that cannot be proven is queued in files
// that reach the package, and the same path on another package is left alone.
export function renameNamespace(ctx, sf, rule, out) {
  const { path } = rule.match;
  const segs = path.split('.');
  const to = rule.transform.to;
  const reaches = ctx.reaches ? ctx.reaches.has(sf.fileName) : moduleRefs(sf, ctx).some((r) => ctx.isPackage(r.spec));
  const rooted = (o) => o?.module && ctx.isPackage(o.module) && o.root !== 'named' && o.props.length === 0;
  const unknown = (o) => !o?.module;
  walk(sf, (n) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name) && n.name.text === segs.at(-1)) {
      let node = n;
      const names = [];
      for (let i = segs.length - 1; i >= 0; i--) {
        if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.name) || node.name.text !== segs[i]) return;
        names.unshift(node.name);
        node = node.expression;
      }
      const origin = ctx.originOf(node);
      if (rooted(origin)) {
        const start = names[0].getStart(sf);
        const end = names.at(-1).getEnd();
        if (!/^[\w$\s.]+$/.test(sf.text.slice(start, end))) out.fail(sf, n, `comments or optional chaining inside ${path}`);
        else out.edit(sf, start, end, to, n);
      } else if (unknown(origin) && reaches) out.fail(sf, n, `receiver of ${path} cannot be traced to ${ctx.packageName}`);
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
  });
}

export function flagManual(ctx, sf, rule, out) {
  for (const c of findCalls(ctx, sf, rule.match.call)) out.fail(sf, c.node, c.proven ? 'manual rule: call site needs a migration' : c.reason);
}

export const TRANSFORMS = {
  'rename-import': renameImport,
  'rename-method': renameMethod,
  'rename-param': renameParam,
  'rename-namespace': renameNamespace,
  manual: flagManual,
};

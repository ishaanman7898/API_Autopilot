import ts from 'typescript';

const MAX_DEPTH = 16;
const isRelative = (s) => s.startsWith('.') || s.startsWith('/');
const keyName = (k) => (ts.isIdentifier(k) || ts.isStringLiteralLike(k) ? k.text : null);

export function unwrap(n) {
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n) || ts.isAwaitExpression(n)
  ) n = n.expression;
  return n;
}

export const fullPath = (o) => (o.root === 'named' ? [o.name] : []).concat(o.props);

// An origin says which export of a package a value came from: { module, root, name?, props, site? }.
// root is namespace, default, named or instance. site is the binding that introduced the last path segment.
export function createResolver(checker, isPackage) {
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
    if (base.local) {
      const exported = checker.getExportsOfModule(base.local).find((s) => s.name === name);
      return exported ? fromSymbol(exported, depth + 1) : null;
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
    if (kind === 'namespace' && target.flags & ts.SymbolFlags.ValueModule) return { local: target };
    return fromSymbol(target, depth + 1);
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

  function fromDeclaration(decl, depth) {
    if (ts.isVariableDeclaration(decl)) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer || !isConst(decl)) return null;
      return originOf(decl.initializer, depth + 1);
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
    return null;
  }

  function fromSymbol(sym, depth) {
    if (!sym || depth > MAX_DEPTH) return null;
    if (sym.flags & ts.SymbolFlags.Alias) {
      const decl = sym.declarations?.[0];
      if (!decl) return null;
      // `export default client` makes the default export an alias of the local binding.
      const local = ts.isVariableDeclaration(decl) || ts.isBindingElement(decl) || ts.isExportAssignment(decl);
      return local ? fromDeclaration(decl, depth) : fromAlias(sym, decl, depth);
    }
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    return decl ? fromDeclaration(decl, depth) : null;
  }

  function originOf(node, depth = 0) {
    node = unwrap(node);
    if (depth > MAX_DEPTH) return null;
    if (ts.isIdentifier(node)) return fromSymbol(checker.getSymbolAtLocation(node), depth + 1);
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
      if (spec !== null) return isPackage(spec) ? { module: spec, root: 'namespace', props: [] } : { module: spec, root: 'other', props: [] };
      const base = originOf(node.expression, depth + 1);
      return base?.module ? { module: base.module, root: 'instance', props: [] } : null;
    }
    return null;
  }

  return { originOf: (n) => originOf(n, 0), moduleArg };
}

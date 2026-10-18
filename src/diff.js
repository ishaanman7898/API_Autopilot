import { SCHEMA } from './rule.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

function operations(spec) {
  const ops = {};
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const params = {};
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        params[`${p.in}:${p.name}`] = p.schema?.type ?? 'any';
      }
      const body = op.requestBody?.content?.['application/json']?.schema?.properties ?? {};
      for (const [name, s] of Object.entries(body)) params[`body:${name}`] = s.type ?? 'any';
      ops[op.operationId] = { route: `${method.toUpperCase()} ${path}`, params };
    }
  }
  return ops;
}

// operationId "charges_create" or "charges.create" -> SDK call "charges.create"
export const toCall = (operationId) => (operationId.includes('.') ? operationId : operationId.replace('_', '.'));

export function diffSpecs(oldSpec, newSpec) {
  const a = operations(oldSpec);
  const b = operations(newSpec);
  const byRoute = (ops) => Object.fromEntries(Object.entries(ops).map(([id, o]) => [o.route, id]));
  const newByRoute = byRoute(b);

  const renamedOps = [];
  const removedOps = [];
  const pairs = [];
  for (const [id, op] of Object.entries(a)) {
    if (b[id]) pairs.push([id, id]);
    else if (newByRoute[op.route]) {
      renamedOps.push({ from: id, to: newByRoute[op.route] });
      pairs.push([id, newByRoute[op.route]]);
    } else removedOps.push(id);
  }
  const addedOps = Object.keys(b).filter((id) => !a[id] && !renamedOps.some((r) => r.to === id));

  const renamedParams = [];
  const removedParams = [];
  for (const [from, to] of pairs) {
    const gone = Object.entries(a[from].params).filter(([k]) => !(k in b[to].params));
    const fresh = Object.entries(b[to].params).filter(([k]) => !(k in a[from].params));
    for (const [k, type] of gone) {
      const [loc, name] = k.split(':');
      const match = fresh.filter(([nk, nt]) => nk.startsWith(loc + ':') && nt === type);
      if (match.length === 1 && gone.filter(([, t]) => t === type).length === 1) {
        renamedParams.push({ operation: to, from: name, to: match[0][0].split(':')[1] });
      } else removedParams.push({ operation: to, param: name });
    }
  }
  return { renamedOps, removedOps, addedOps, renamedParams, removedParams };
}

// Draft rules from a spec diff. Renames become deterministic transforms; removals become agent work.
// Drafts are never signed or applied until a provider reviews them.
export function draftRules(diff, { provider, pkg, from, to }) {
  const rules = [];
  for (const r of diff.renamedOps) {
    rules.push({ id: `rename-${r.from}`, kind: 'rename-method', match: { call: toCall(r.from) }, transform: { to: toCall(r.to) } });
  }
  for (const p of diff.renamedParams) {
    rules.push({
      id: `rename-param-${p.operation}-${p.from}`,
      kind: 'rename-param',
      match: { call: toCall(p.operation), param: p.from },
      transform: { to: p.to },
    });
  }
  for (const id of diff.removedOps) {
    rules.push({
      id: `removed-${id}`, kind: 'manual', match: { call: toCall(id) },
      fallback: { prompt: `${toCall(id)} was removed in ${provider} ${to}. Replace it using the new API and keep behaviour identical.` },
    });
  }
  for (const p of diff.removedParams) {
    rules.push({
      id: `removed-param-${p.operation}-${p.param}`, kind: 'manual', match: { call: toCall(p.operation) },
      fallback: { prompt: `Parameter ${p.param} was removed from ${toCall(p.operation)}. Drop or replace its usage.` },
    });
  }
  return {
    schema: SCHEMA, draft: true, provider, package: pkg, id: `${pkg}-${from}-to-${to}`, from, to,
    sunset: new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10), rules,
  };
}

import { SCHEMA } from './rule.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const MAX_DEPTH = 8;

function resolveRef(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return {};
  let node = spec;
  for (const part of ref.slice(2).split('/')) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  return node ?? {};
}

// Follows $ref chains. A cycle or a dangling reference yields an empty schema.
function deref(spec, node) {
  const seen = new Set();
  while (node && typeof node === 'object' && node.$ref) {
    if (seen.has(node.$ref)) return {};
    seen.add(node.$ref);
    node = resolveRef(spec, node.$ref);
  }
  return node ?? {};
}

function describeType(spec, schema, depth = 0) {
  const s = deref(spec, schema);
  if (depth > MAX_DEPTH) return 'deep';
  if (s.oneOf || s.anyOf) return 'oneOf';
  const members = s.allOf?.map((m) => deref(spec, m)) ?? [];
  const type = s.type ?? (members.find((m) => m.type)?.type) ?? (s.properties || members.some((m) => m.properties) ? 'object' : 'any');
  const base = type === 'array' ? `array<${describeType(spec, s.items, depth + 1)}>` : type;
  const parts = [base + (s.nullable ? '?' : '')];
  if (s.format) parts.push(`format=${s.format}`);
  if (Array.isArray(s.enum)) parts.push(`enum=${[...s.enum].map(String).sort().join('|')}`);
  return parts.join(',');
}

// Properties of an object schema, merging allOf. Returns Map name -> { type, required }.
function properties(spec, schema, depth = 0) {
  const s = deref(spec, schema);
  const out = new Map();
  if (depth > MAX_DEPTH) return out;
  for (const member of s.allOf ?? []) for (const [k, v] of properties(spec, member, depth + 1)) out.set(k, v);
  const required = new Set(s.required ?? []);
  for (const [name, prop] of Object.entries(s.properties ?? {})) out.set(name, { type: describeType(spec, prop), required: required.has(name) });
  for (const name of required) if (!out.has(name)) out.set(name, { type: 'any', required: true });
  return out;
}

const jsonSchema = (spec, content) => {
  const c = deref(spec, content) ?? {};
  const media = c['application/json'] ?? Object.values(c)[0];
  return media?.schema;
};

function operationsOf(spec) {
  const ops = new Map();
  for (const [path, rawItem] of Object.entries(spec.paths ?? {})) {
    const item = deref(spec, rawItem);
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const params = new Map();
      for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const p = deref(spec, raw);
        if (p.name && p.in) params.set(`${p.in}:${p.name}`, { where: p.in, name: p.name, type: describeType(spec, p.schema), required: p.required === true || p.in === 'path' });
      }
      const body = properties(spec, jsonSchema(spec, deref(spec, op.requestBody).content));
      for (const [name, v] of body) params.set(`body:${name}`, { where: 'body', name, ...v });
      const ok = Object.entries(op.responses ?? {}).filter(([code]) => /^2/.test(code)).sort(([a], [b]) => (a < b ? -1 : 1))[0];
      const response = ok ? properties(spec, jsonSchema(spec, deref(spec, ok[1]).content)) : new Map();
      ops.set(op.operationId, { id: op.operationId, method: method.toUpperCase(), path, params, response });
    }
  }
  return ops;
}

export function checkSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'spec is not a JSON object';
  if (typeof spec.swagger === 'string') return `Swagger ${spec.swagger} is not supported, use OpenAPI 3.x`;
  if (typeof spec.openapi !== 'string' || !/^3\./.test(spec.openapi)) return 'spec.openapi must be 3.x';
  return null;
}

const template = (path) => path.replace(/\{[^}]+\}/g, '{}');

export function diffSpecs(oldSpec, newSpec) {
  for (const s of [oldSpec, newSpec]) {
    const err = checkSpec(s);
    if (err) throw new Error(err);
  }
  const a = operationsOf(oldSpec);
  const b = operationsOf(newSpec);
  const newByRoute = new Map();
  for (const op of b.values()) newByRoute.set(`${op.method} ${template(op.path)}`, [...(newByRoute.get(`${op.method} ${template(op.path)}`) ?? []), op.id]);
  const oldByRoute = new Map();
  for (const op of a.values()) oldByRoute.set(`${op.method} ${template(op.path)}`, [...(oldByRoute.get(`${op.method} ${template(op.path)}`) ?? []), op.id]);

  const diff = { renamedOps: [], candidateOps: [], removedOps: [], addedOps: [], pathChanges: [], params: { renamed: [], removed: [], added: [], typeChanged: [] }, response: { removed: [], typeChanged: [] } };
  const pairs = [];
  const unmatchedOld = [];
  for (const op of a.values()) {
    if (b.has(op.id)) {
      pairs.push([op.id, op.id]);
      const next = b.get(op.id);
      if (next.method !== op.method || next.path !== op.path) diff.pathChanges.push({ operation: op.id, from: `${op.method} ${op.path}`, to: `${next.method} ${next.path}` });
      continue;
    }
    const route = `${op.method} ${template(op.path)}`;
    const sameOld = oldByRoute.get(route);
    const sameNew = (newByRoute.get(route) ?? []).filter((id) => !a.has(id));
    if (sameOld.length === 1 && sameNew.length === 1) {
      diff.renamedOps.push({ from: op.id, to: sameNew[0], route });
      pairs.push([op.id, sameNew[0]]);
    } else unmatchedOld.push(op);
  }
  const matchedNew = new Set(pairs.map(([, n]) => n));
  const unmatchedNew = [...b.values()].filter((o) => !a.has(o.id) && !matchedNew.has(o.id));
  for (const old of unmatchedOld) {
    const candidates = unmatchedNew.filter((n) => n.method === old.method);
    const reverse = unmatchedOld.filter((o) => o.method === old.method);
    if (candidates.length === 1 && reverse.length === 1) {
      diff.candidateOps.push({ from: old.id, to: candidates[0].id });
      pairs.push([old.id, candidates[0].id]);
      matchedNew.add(candidates[0].id);
    } else diff.removedOps.push(old.id);
  }
  diff.addedOps = unmatchedNew.filter((n) => !matchedNew.has(n.id)).map((n) => n.id).sort();
  diff.removedOps.sort();

  for (const [from, to] of pairs) {
    const x = a.get(from);
    const y = b.get(to);
    const gone = [...x.params].filter(([k]) => !y.params.has(k)).map(([, v]) => v);
    const fresh = [...y.params].filter(([k]) => !x.params.has(k)).map(([, v]) => v);
    const used = new Set();
    for (const g of gone) {
      const same = (p) => p.where === g.where && p.type === g.type;
      const goneSame = gone.filter(same);
      const freshSame = fresh.filter(same);
      if (goneSame.length === 1 && freshSame.length === 1) {
        diff.params.renamed.push({ operation: to, where: g.where, from: g.name, to: freshSame[0].name, type: g.type, sameRequired: g.required === freshSame[0].required });
        used.add(`${freshSame[0].where}:${freshSame[0].name}`);
      } else diff.params.removed.push({ operation: to, where: g.where, name: g.name });
    }
    for (const f of fresh) if (!used.has(`${f.where}:${f.name}`)) diff.params.added.push({ operation: to, where: f.where, name: f.name, required: f.required });
    for (const [k, p] of x.params) {
      const q = y.params.get(k);
      if (q && (q.type !== p.type || (q.required && !p.required))) diff.params.typeChanged.push({ operation: to, where: p.where, name: p.name, from: p.type + (p.required ? ' required' : ''), to: q.type + (q.required ? ' required' : '') });
    }
    for (const [name, p] of x.response) {
      const q = y.response.get(name);
      if (!q) diff.response.removed.push({ operation: to, name });
      else if (q.type !== p.type) diff.response.typeChanged.push({ operation: to, name, from: p.type, to: q.type });
    }
  }
  return diff;
}

// Naming conventions between an operationId and the SDK method a customer calls.
export const NAMINGS = {
  underscore: (id) => (id.includes('.') ? id : id.replace('_', '.')),
  identity: (id) => id,
};

// Drafts never claim certainty. confidence is "likely" only for one-to-one structural evidence
// under a naming convention the publisher chose, and everything else is "needs-review".
export function draftRules(diff, { provider, pkg, from, to, naming = null }) {
  const call = NAMINGS[naming ?? 'underscore'];
  const rules = [];
  const ids = new Set();
  const add = (rule) => {
    let id = rule.id.replace(/[^\w.-]+/g, '-');
    for (let n = 2; ids.has(id); n++) id = `${rule.id.replace(/[^\w.-]+/g, '-')}-${n}`;
    ids.add(id);
    rules.push({ ...rule, id });
  };
  const assumes = naming ? '' : ' Assumes SDK method names follow operationId; pass --naming to state the convention.';
  const manual = (op, confidenceEvidence, prompt) => add({
    id: `manual-${op}-${rules.length + 1}`, kind: 'manual', confidence: 'needs-review', evidence: confidenceEvidence,
    match: { call: call(op) }, fallback: { prompt },
  });

  for (const r of diff.renamedOps) {
    add({ id: `rename-${r.from}`, kind: 'rename-method', confidence: naming ? 'likely' : 'needs-review', evidence: `same route ${r.route}, one old and one new operation.${assumes}`, match: { call: call(r.from) }, transform: { to: call(r.to) } });
  }
  for (const r of diff.candidateOps) {
    add({ id: `rename-${r.from}`, kind: 'rename-method', confidence: 'needs-review', evidence: `only unmatched ${r.from} and ${r.to} share an HTTP method. The route changed, so this is a guess.${assumes}`, match: { call: call(r.from) }, transform: { to: call(r.to) } });
  }
  for (const p of diff.params.renamed) {
    const body = p.where === 'body';
    add({
      id: `rename-param-${p.operation}-${p.from}`, kind: 'rename-param',
      confidence: naming && body && p.sameRequired ? 'likely' : 'needs-review',
      evidence: `${p.where} parameter ${p.from} removed and ${p.to} added with the same type (${p.type}).${body ? '' : ' Non-body parameters are often positional in SDKs.'}${assumes}`,
      match: { call: call(p.operation), param: p.from }, transform: { to: p.to },
    });
  }
  for (const id of diff.removedOps) manual(id, 'operation has no counterpart in the new spec', `${call(id)} was removed in ${provider} ${to}. Find the replacement and keep behaviour identical.`);
  for (const p of diff.params.removed) manual(p.operation, `${p.where} parameter ${p.name} has no counterpart`, `Parameter ${p.name} was removed from ${call(p.operation)}. Drop or replace its usage.`);
  for (const p of diff.params.added.filter((x) => x.required)) manual(p.operation, `new required ${p.where} parameter ${p.name}`, `${call(p.operation)} now requires ${p.name}. Supply it at each call site.`);
  for (const t of diff.params.typeChanged) manual(t.operation, `${t.where} parameter ${t.name} changed from ${t.from} to ${t.to}`, `The type of ${t.name} in ${call(t.operation)} changed from ${t.from} to ${t.to}. Convert values at each call site.`);
  for (const f of diff.response.removed) manual(f.operation, `response field ${f.name} removed`, `${call(f.operation)} no longer returns ${f.name}. Update code that reads it.`);
  for (const f of diff.response.typeChanged) manual(f.operation, `response field ${f.name} changed from ${f.from} to ${f.to}`, `${call(f.operation)} now returns ${f.name} as ${f.to}. Update code that reads it.`);

  const sunset = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  return {
    ruleSet: { schema: SCHEMA, draft: true, provider, package: pkg, id: `${pkg}-${from}-to-${to}`, from, to, sunset, rules },
    report: { pathChanges: diff.pathChanges, addedOperations: diff.addedOps, namingAssumption: naming ?? 'underscore (not confirmed)', needsReview: rules.filter((r) => r.confidence === 'needs-review').length, likely: rules.filter((r) => r.confidence === 'likely').length },
  };
}

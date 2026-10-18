import { createHash } from 'node:crypto';

export const SCHEMA = 'apimigrate/1';
export const KINDS = ['rename-import', 'rename-method', 'rename-param', 'replace', 'manual'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;

// Sorted-key JSON. Throws on values JSON cannot carry so two different rules never share a hash.
export function canonical(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number in rule');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  throw new Error(`cannot canonicalize ${typeof v}`);
}

export function hashRuleSet(ruleSet) {
  const { signature, ...body } = ruleSet;
  return createHash('sha256').update(canonical(body)).digest('hex');
}

export function validateRuleSet(rs) {
  const errors = [];
  if (!rs || typeof rs !== 'object') return ['rule file is not an object'];
  if (rs.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  for (const f of ['provider', 'id', 'from', 'to', ...(rs.scope === 'any' ? [] : ['package'])]) {
    if (typeof rs[f] !== 'string' || !rs[f]) errors.push(`missing ${f}`);
  }
  if (rs.scope !== undefined && rs.scope !== 'any') errors.push('scope must be "any" or omitted');
  if (typeof rs.sunset !== 'string' || !ISO_DATE.test(rs.sunset) || Number.isNaN(Date.parse(rs.sunset))) errors.push('sunset must be an ISO date');
  if (!Array.isArray(rs.rules) || rs.rules.length === 0) errors.push('rules must be a non-empty array');
  const ids = new Set();
  for (const [i, r] of (rs.rules ?? []).entries()) {
    const at = `rules[${i}]`;
    if (!r.id || ids.has(r.id)) errors.push(`${at}: id missing or duplicate`);
    ids.add(r.id);
    if (!KINDS.includes(r.kind)) errors.push(`${at}: unknown kind ${r.kind}`);
    if (r.kind === 'rename-import' && !(r.match?.module && r.transform?.to)) errors.push(`${at}: needs match.module and transform.to`);
    if (r.kind === 'rename-method' && !(r.match?.call && r.transform?.to)) errors.push(`${at}: needs match.call and transform.to`);
    if (r.kind === 'rename-param' && !(r.match?.call && r.match?.param && r.transform?.to)) errors.push(`${at}: needs match.call, match.param and transform.to`);
    if (r.kind === 'replace') {
      try { new RegExp(r.match?.pattern); } catch { errors.push(`${at}: match.pattern must be a valid regex`); }
      if (typeof r.transform?.to !== 'string') errors.push(`${at}: needs transform.to`);
      if (!Array.isArray(r.match?.files) || r.match.files.length === 0) errors.push(`${at}: replace rules need match.files`);
    }
    if (r.kind === 'manual' && !(r.match?.call && r.fallback?.prompt)) errors.push(`${at}: needs match.call and fallback.prompt`);
  }
  return errors;
}

// A missing or unreadable sunset counts as expired.
export function isSunset(rs, now = new Date()) {
  const t = Date.parse(rs?.sunset);
  return Number.isNaN(t) || t <= now.getTime();
}

// Drafts and unreviewed rules cannot be signed. The publisher removes the marks after reading each rule.
export function signingBlockers(rs) {
  const blockers = [];
  if (rs.draft) blockers.push('file is marked draft');
  for (const r of rs.rules ?? []) if (r.confidence) blockers.push(`rule ${r.id} still has confidence "${r.confidence}"`);
  return blockers;
}

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const SCHEMA = 'apimigrate/1';
export const KINDS = ['rename-import', 'rename-method', 'rename-param', 'replace', 'manual'];

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function hashRuleSet(ruleSet) {
  const { signature, ...body } = ruleSet;
  return createHash('sha256').update(canonical(body)).digest('hex');
}

export function validateRuleSet(rs) {
  const errors = [];
  if (rs.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  for (const f of ['provider', 'id', 'from', 'to', ...(rs.scope === 'any' ? [] : ['package'])]) {
    if (typeof rs[f] !== 'string' || !rs[f]) errors.push(`missing ${f}`);
  }
  if (!rs.sunset || Number.isNaN(Date.parse(rs.sunset))) errors.push('sunset must be an ISO date');
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
    }
    if (r.kind === 'manual' && !(r.match?.call && r.fallback?.prompt)) errors.push(`${at}: needs match.call and fallback.prompt`);
  }
  return errors;
}

export function isSunset(rs, now = new Date()) {
  return Date.parse(rs.sunset) < now.getTime();
}

export function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function signRuleSet(rs, privatePem, keyId) {
  const { signature, ...body } = rs;
  const hash = hashRuleSet(body);
  const sig = sign(null, Buffer.from(hash, 'hex'), createPrivateKey(privatePem)).toString('base64');
  return { ...body, signature: { alg: 'ed25519', keyId, hash, sig } };
}

// keys: [{ keyId, publicKey }] as published at /.well-known/apimigrate-keys.json
export function verifyRuleSet(rs, keys) {
  const s = rs.signature;
  if (!s) return { ok: false, reason: 'unsigned' };
  if (s.alg !== 'ed25519') return { ok: false, reason: `unsupported alg ${s.alg}` };
  const hash = hashRuleSet(rs);
  if (hash !== s.hash) return { ok: false, reason: 'rule content does not match signed hash' };
  const key = keys.find((k) => k.keyId === s.keyId);
  if (!key) return { ok: false, reason: `no published key ${s.keyId}` };
  const ok = verify(null, Buffer.from(hash, 'hex'), createPublicKey(key.publicKey), Buffer.from(s.sig, 'base64'));
  return ok ? { ok, hash } : { ok: false, reason: 'bad signature' };
}

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { hashRuleSet } from './rule.js';

export class TrustError extends Error {
  constructor(message, code = 'trust') {
    super(message);
    this.code = code;
  }
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
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TrustError('signing key must be ed25519', 'bad-key');
  const hash = hashRuleSet(body);
  const sig = sign(null, Buffer.from(hash, 'hex'), key).toString('base64');
  return { ...body, signature: { alg: 'ed25519', keyId, hash, sig } };
}

function keyWindow(key, now) {
  if (key.revoked === true) return 'key is revoked';
  const t = now.getTime();
  if (key.notBefore !== undefined && !(Date.parse(key.notBefore) <= t)) return 'key is not valid yet';
  if (key.expires !== undefined && !(t < Date.parse(key.expires))) return 'key has expired';
  return null;
}

// Fails closed: any missing, malformed, expired, revoked or mismatching piece returns ok false with a reason.
export function verifyRuleSet(rs, keys, now = new Date()) {
  const s = rs?.signature;
  if (!s || typeof s !== 'object') return { ok: false, reason: 'unsigned' };
  if (s.alg !== 'ed25519') return { ok: false, reason: `unsupported alg ${s.alg}` };
  if (typeof s.keyId !== 'string' || typeof s.sig !== 'string' || typeof s.hash !== 'string') return { ok: false, reason: 'malformed signature block' };
  let hash;
  try { hash = hashRuleSet(rs); } catch (e) { return { ok: false, reason: `rule cannot be hashed: ${e.message}` }; }
  if (hash !== s.hash) return { ok: false, reason: 'rule content does not match signed hash' };
  const matching = keys.filter((k) => k.keyId === s.keyId);
  if (matching.length === 0) return { ok: false, reason: `no published key ${s.keyId}` };
  if (matching.length > 1) return { ok: false, reason: `key id ${s.keyId} is published more than once` };
  const [key] = matching;
  const window = keyWindow(key, now);
  if (window) return { ok: false, reason: window };
  let good = false;
  try {
    const pub = createPublicKey(key.publicKey);
    if (pub.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'published key is not ed25519' };
    good = verify(null, Buffer.from(hash, 'hex'), pub, Buffer.from(s.sig, 'base64'));
  } catch (e) {
    return { ok: false, reason: `key or signature unreadable: ${e.message}` };
  }
  return good ? { ok: true, hash, keyId: s.keyId } : { ok: false, reason: 'bad signature' };
}

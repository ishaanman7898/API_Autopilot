import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TrustError } from './signing.js';

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const MAX_BYTES = 64 * 1024;
const MAX_KEYS = 50;

// Accepts { keys: [{ keyId, publicKey, notBefore?, expires?, revoked? }] }. Anything else is an error.
export function parseKeySet(value) {
  const list = value?.keys;
  if (!Array.isArray(list) || list.length === 0) throw new TrustError('key set has no keys', 'bad-keys');
  if (list.length > MAX_KEYS) throw new TrustError('key set is too large', 'bad-keys');
  const seen = new Set();
  return list.map((k, i) => {
    if (typeof k?.keyId !== 'string' || !k.keyId) throw new TrustError(`keys[${i}] has no keyId`, 'bad-keys');
    if (seen.has(k.keyId)) throw new TrustError(`keyId ${k.keyId} is duplicated`, 'bad-keys');
    seen.add(k.keyId);
    for (const f of ['notBefore', 'expires']) {
      if (k[f] !== undefined && Number.isNaN(Date.parse(k[f]))) throw new TrustError(`keys[${i}].${f} is not a date`, 'bad-keys');
    }
    try {
      if (createPublicKey(k.publicKey).asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    } catch (e) {
      throw new TrustError(`keys[${i}] is not a usable ed25519 public key: ${e.message}`, 'bad-keys');
    }
    return k;
  });
}

export function loadKeySetFile(path, pemKeyId) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new TrustError(`cannot read key file: ${e.message}`, 'bad-keys'); }
  if (path.endsWith('.pem')) return [{ keyId: pemKeyId, publicKey: text }];
  try { return parseKeySet(JSON.parse(text)); } catch (e) {
    throw e instanceof TrustError ? e : new TrustError(`key file is not valid JSON: ${e.message}`, 'bad-keys');
  }
}

// HTTPS only, no redirects, bounded time and size. Any failure throws.
export async function fetchKeySet(domain, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!HOST.test(domain)) throw new TrustError(`${domain} is not a valid host name`, 'fetch');
  const url = `https://${domain}/.well-known/apimigrate-keys.json`;
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  } catch (e) {
    throw new TrustError(`could not fetch ${url}: ${e.message}`, 'fetch');
  }
  if (!res.ok) throw new TrustError(`could not fetch ${url}: HTTP ${res.status}`, 'fetch');
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new TrustError(`${url} is larger than ${MAX_BYTES} bytes`, 'fetch');
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new TrustError(`${url} is larger than ${MAX_BYTES} bytes`, 'fetch');
  try { return parseKeySet(JSON.parse(text)); } catch (e) {
    throw e instanceof TrustError ? e : new TrustError(`${url} is not valid JSON`, 'bad-keys');
  }
}

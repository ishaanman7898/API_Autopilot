import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../errors.js';
import { generateKeys } from '../signing.js';

export const spec = {
  name: 'keygen',
  summary: 'create an ed25519 signing key pair and a publishable key set',
  usage: 'keygen [--out dir] [--key-id id] [--force]',
  value: ['out', 'key-id'],
  bool: ['force'],
  positional: 0,
  options: [['--out dir', 'where to write the files, default current directory'], ['--key-id id', 'id recorded in the key set, default k1'], ['--force', 'overwrite existing key files']],
};

export function run({ flags }, io) {
  const out = flags.out ?? '.';
  const keyId = flags['key-id'] ?? 'k1';
  const priv = join(out, 'apimigrate-private.pem');
  const pub = join(out, 'apimigrate-public.pem');
  const set = join(out, 'apimigrate-keys.json');
  if (!flags.force && [priv, pub, set].some(existsSync)) throw new UsageError(`key files already exist in ${out}, pass --force to overwrite`);
  const { publicPem, privatePem } = generateKeys();
  writeFileSync(priv, privatePem, { mode: 0o600 });
  try { chmodSync(priv, 0o600); } catch { /* not supported on every platform */ }
  writeFileSync(pub, publicPem);
  writeFileSync(set, JSON.stringify({ keys: [{ keyId, publicKey: publicPem }] }, null, 2) + '\n');
  io.out(`wrote ${priv} (keep secret), ${pub} and ${set}`);
  io.out('publish apimigrate-keys.json at https://<your domain>/.well-known/apimigrate-keys.json');
  return 0;
}

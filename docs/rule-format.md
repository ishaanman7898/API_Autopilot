# Rule format (`apimigrate/1`)

A rule file is JSON.

```json
{
  "schema": "apimigrate/1",
  "provider": "acme",
  "package": "acme-sdk",
  "id": "acme-sdk-1-to-2",
  "from": "1.x",
  "to": "2.x",
  "sunset": "2027-12-31",
  "rules": [],
  "signature": { "alg": "ed25519", "keyId": "k1", "hash": "...", "sig": "..." }
}
```

| Field | Meaning |
| --- | --- |
| `provider` | Whoever ships the change: a company, project or team |
| `package` | The dependency the change belongs to. Code rules only run in files that import it. Optional when `scope` is `any` |
| `scope` | Omit for import-gated code migration. `"any"` runs rules on every scanned file |
| `from` / `to` | Version range being migrated |
| `sunset` | ISO date after which the engine refuses the rule |
| `draft` | Set by `apimigrate draft`; drafts are unsigned and meant for review |

## Rule kinds

| Kind | Needs | Effect |
| --- | --- | --- |
| `rename-import` | `match.module`, `transform.to` | Rewrites the module specifier, including subpaths |
| `rename-method` | `match.call`, `transform.to` | Renames `a.b.c(` call sites, e.g. `charges.create` to `payments.create` |
| `rename-param` | `match.call`, `match.param`, `transform.to` | Renames an object key inside that call's arguments. Shorthand `{ x }` becomes `{ new: x }`. If the args are not an object literal, the site goes to the agent queue |
| `replace` | `match.pattern` (regex), `transform.to`, optional `match.flags`, `match.files` | Regex replacement for anything else: config keys, flags, text. `match.files` limits by filename suffix. `transform.to` may use `$1` groups |
| `manual` | `match.call`, `fallback.prompt` | No transform. Every matching call site is queued for an agent with the prompt |

Every rule needs a unique `id`. Any rule may carry a `fallback.prompt`.

## Signing
The hash is SHA-256 of the canonical (sorted-key) JSON of the rule file without its `signature`. The signature is ed25519 over that hash. Verifying checks that the content still matches the hash and the signature matches a key published by the provider. Any edit to a signed file invalidates it.

## Key publication
Serve `https://<provider-domain>/.well-known/apimigrate-keys.json`:

```json
{ "keys": [ { "keyId": "k1", "publicKey": "-----BEGIN PUBLIC KEY-----\n..." } ] }
```

Consumers can instead pass `--pubkey file.pem` if they pin a key out of band.

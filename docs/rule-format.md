# Rule format

A rule file is JSON with schema `apimigrate/1`.

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

## Fields

| Field | Meaning |
| --- | --- |
| `provider` | Whoever ships the change. Consumers can restrict this in `.apimigrate.yml`. |
| `package` | The dependency the change belongs to. Required unless `scope` is `any`. |
| `scope` | Omit it for code migration. `"any"` allows a rule file with no package, for `replace` rules. |
| `from`, `to` | The versions being migrated. |
| `sunset` | An ISO date. After it the tool refuses the rule. A missing or invalid date counts as expired. |
| `draft` | Set by `apimigrate draft`. A file with this field cannot be signed. |

## Rule kinds

| Kind | Needs | Effect |
| --- | --- | --- |
| `rename-import` | `match.module`, `transform.to` | Rewrites the module name in import, export from, require, dynamic import, import type and JSDoc `import()` types such as `@param {import('acme-sdk').Job}`. Subpaths are kept. A string equal to the module name anywhere else is queued. |
| `rename-method` | `match.call`, `transform.to` | Renames a call such as `charges.create` to `payments.create`, only where the receiver is proven to come from the package. |
| `rename-param` | `match.call`, `match.param`, `transform.to`, optional `match.arg` | Renames an object key in the call argument, which is argument 0 by default. |
| `rename-namespace` | `match.path`, `transform.to` | Renames a property path such as `robotsPreview` to `robots`, or `data.filters` to `data.dimensions`, wherever it directly follows a proven package value, in calls, in plain reads and in type names such as `Acme.RobotsPreview.Job`, `typeof client.robotsPreview` and JSDoc types. The path is matched as written, so a type namespace `RobotsPreview` needs its own rule. A one-segment path is also renamed in destructuring and in named imports from the package, keeping the local name. The same path on a value that cannot be proven is queued. |
| `positional-to-named` | `match.call`, `match.positional`, `transform.names` | Moves the first positional arguments of a call into its params object, as when an SDK switches to named path parameters: with `positional: 2` and `names: ['parent_id']`, `retrieve('p_1', 'c_1')` becomes `retrieve('c_1', { parent_id: 'p_1' })`. The keys are merged into an existing params object, or a new one is made. A call already in the new shape is left alone. A call whose arguments could have side effects, uses a spread, or already has the key is queued. |
| `rename-dependency` | `match.dependency`, and `transform.to`, `transform.version` or both | Renames the dependency, sets its version range, or both, in `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies` of every `package.json` in the repository. Edits go through a JSON parse, so formatting and key order are kept. A manifest that already lists the new name, or is not valid JSON, is queued. Lockfiles are not changed. |
| `replace` | `match.pattern`, `match.files`, `transform.to`, optional `match.flags` | Regex replacement in files whose path ends with one of `match.files`. Not parse-verified. |
| `manual` | `match.call`, `fallback.prompt` | No rewrite. Every matching call site is queued with the prompt. |

Every rule needs a unique `id`. Rules run in order, and each one sees the output of the one before it. That is why a `rename-param` rule usually names the call as it is after the `rename-method` rule.

How a call is matched, and what happens when it cannot be proven, is described in [matching](matching.md).

## Signing

The hash is SHA-256 of the canonical JSON of the file without its `signature`. Canonical JSON sorts keys and refuses values JSON cannot carry. The signature is ed25519 over the hash. Any edit to a signed file breaks it.

A rule is refused when it is unsigned, when the hash does not match, when the key id is not published or is published twice, when the key is revoked, expired or not yet valid, when the key is not ed25519, or when the signature is bad.

## Key sets

A publisher serves a key set at `https://<domain>/.well-known/apimigrate-keys.json`.

```json
{
  "keys": [
    { "keyId": "k1", "publicKey": "-----BEGIN PUBLIC KEY-----\n...", "expires": "2027-01-01", "revoked": false },
    { "keyId": "k2", "publicKey": "-----BEGIN PUBLIC KEY-----\n...", "notBefore": "2026-12-01" }
  ]
}
```

`notBefore`, `expires` and `revoked` are optional. A key must be inside its window at verification time. To rotate, publish the new key, sign rules with it, and set `expires` or `revoked` on the old key. Rules signed with a retired key must be signed again.

A consumer can also pass `--keys` with a key set file they committed, or `--pubkey` with a single PEM file.

## Rule index

A publisher can also list its rule files at `https://<domain>/.well-known/apimigrate-rules.json`, so `apimigrate watch` finds them when a new major version comes out. `from` and `to` are version lines: the major, or `0.minor` below 1.0.

```json
{ "rules": [{ "package": "acme-sdk", "from": "1", "to": "2", "url": "https://acme.com/rules/acme-sdk-1-to-2.json" }] }
```

The index is not signed. Each rule file it points to must be signed by a key in the same domain's key set. See [CLI reference](cli.md#watch).

`apimigrate index` builds it from a folder of signed rule files. It checks each one against the key set, reads the lines from `from` and `to`, and refuses drafts, unsigned files, files past their sunset, versions that name no line, and two files for the same package and lines.

```sh
apimigrate index rules --base-url https://acme.com/rules --keys apimigrate-keys.json --out .well-known/apimigrate-rules.json
```

Serve the files in `rules` at `https://acme.com/rules/`, and the index and key set under `/.well-known/` of the domain that consumers list in `sources`. See [CLI reference](cli.md#index).

## Draft marks

`apimigrate draft` adds `draft: true` and gives each rule a `confidence` of `likely` or `needs-review` plus an `evidence` sentence. `sign` refuses a file that still has them. The publisher reads each rule, then removes the marks. See [drafting rules](draft.md).

Related docs are [matching](matching.md), [drafting rules](draft.md), [security](security.md) and [CLI reference](cli.md).

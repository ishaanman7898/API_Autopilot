# CLI reference

Run with `node bin/apimigrate.js <command>` (or `apimigrate` once installed). Node 20+, no dependencies.

| Command | Purpose |
| --- | --- |
| `keygen [--out dir]` | Create `apimigrate-private.pem` and `apimigrate-public.pem` (ed25519) |
| `lint <rules.json>` | Validate a rule file |
| `sign <rules.json> --key priv.pem [--key-id k1] [--out file]` | Sign a rule file (in place unless `--out`) |
| `check <rules.json> --pubkey pub.pem` or `--well-known domain` | Verify a signature |
| `draft <old-spec.json> <new-spec.json> [--provider --package --from --to --out]` | Diff two OpenAPI specs and draft rename and removal rules |
| `apply --rules r.json (--pubkey pem or --well-known domain) [--root dir] [--dry-run] [--test-cmd cmd] [--cov-base f --cov-head f] [--allow-unsigned]` | Apply a rule to a repo |
| `verify --rules r.json --evidence e.json [--root dir]` | Replay the deterministic pass on a base checkout and compare digests |
| `gate <baseDir> <headDir> [--cov-base f --cov-head f]` | Run only the assertion, coverage and secret gate |

## `apply` in order
1. Validate the rule, check the sunset date, check `.apimigrate.yml` allows the provider and the rule hash is pinned (if pins are set).
2. Verify the signature. Unsigned or invalid rules are refused unless `--allow-unsigned`.
3. Read the files under `paths`, apply the deterministic rules, write changes (not with `--dry-run`).
4. Optionally run `--test-cmd`.
5. Run the gate, write `.apimigrate/evidence.json`, `.apimigrate/unresolved.json` (if any) and append to `.apimigrate/audit.log`.
6. Exit non-zero if the gate or tests fail.

## `.apimigrate.yml`

```yaml
providers: [acme]       # only these providers' rules may run
paths:                  # directories or files to scan, default "."
  - src
  - test
extensions: [.ts, .js, .json]   # default: .js .ts .jsx .tsx .mjs .cjs
pins:                   # only these rule hashes may run
  - 673148db71c5...
draft: true             # PRs open as drafts
reviewers: [alice]
model: claude-sonnet-5-5   # for the agent fallback
```

Nothing auto merges.

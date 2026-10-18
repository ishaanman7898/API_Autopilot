# API Autopilot

When an API provider ships a breaking change, its customers rewrite code by hand. API Autopilot lets the provider publish a **signed migration rule** and lets the customer apply it with an engine that proves what it did.

- **Signed rules.** A rule file holds matchers, deterministic transforms, an agent fallback prompt and a sunset date. It is signed with ed25519; the key is published at `/.well-known/apimigrate-keys.json`.
- **Deterministic first.** The engine rewrites imports, method calls and parameter names. Only call sites it cannot prove it handled go to an agent, fenced as untrusted text (`.apimigrate/unresolved.json`).
- **Verifiable PRs.** Every run writes an evidence bundle: rule hash and key, call sites changed, per-file digests, gate result, test result.
- **Cheat-proof gate.** The run fails if assertions or line coverage drop, a test file disappears, or the diff adds a secret.
- **Replay.** `apimigrate verify` re-runs the migration on the PR's base commit and compares digests.
- **Drafts from specs.** `apimigrate draft old.json new.json` diffs two OpenAPI specs and drafts rename and removal rules for a provider to review.

## Use

```sh
node bin/apimigrate.js keygen                       # provider, once
node bin/apimigrate.js sign rules.json --key apimigrate-private.pem
node bin/apimigrate.js apply --rules rules.json --well-known api.acme.com --test-cmd "npm test"
node bin/apimigrate.js verify --rules rules.json --evidence .apimigrate/evidence.json   # on the base commit
```

Per-repo settings live in `.apimigrate.yml`: `providers`, `paths`, `pins` (allowed rule hashes), `draft`, `reviewers`, `model`. Nothing auto merges; the GitHub Action opens a draft PR.

See `examples/` for a rule file and a sample app. Zero dependencies, Node 20+. Run `npm test`.

## Scope

v0 targets JavaScript and TypeScript call sites with regex-level matching scoped to files that import the provider package. It is a prototype of the rule format and trust model, not a full codemod engine.

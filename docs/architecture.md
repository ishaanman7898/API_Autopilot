# Architecture

```
rules.json ---> rule.js       validate, hash, sign, verify
repo files ---> engine.js     deterministic rewrite -> changed files
                              and unresolved.json (fenced, scanned)
               gate.js        assertions, coverage, secrets
               evidence.js    evidence bundle, replay
OpenAPI diff -> diff.js       draft rules for review
.apimigrate.yml -> config.js
cli.js, bin/apimigrate.js     commands
```

| File | Role |
| --- | --- |
| `src/rule.js` | Schema validation, canonical JSON, SHA-256 hash, ed25519 sign and verify, sunset check |
| `src/engine.js` | Pure function: `applyRuleSet(ruleSet, {path: text}) -> {files, changes, unresolved}`. Import-gated unless `scope: any` |
| `src/sanitize.js` | Injection and secret scanners, fence for untrusted text |
| `src/gate.js` | `runGate({base, head, coverage...})` |
| `src/evidence.js` | `buildEvidence` and `replay` |
| `src/diff.js` | `diffSpecs` and `draftRules` for OpenAPI documents |
| `src/config.js` | Flat YAML subset parser and defaults |
| `src/cli.js` | File IO, commands, audit log |

The core modules are pure and operate on `{path: contents}` maps, so the engine can run on a CI runner, in a GitHub App, or inside another tool.

## Flow of one migration
The publisher signs a rule. Consumer CI runs `apply`. Deterministic edits are written and unresolved sites are queued. The gate and tests run, the evidence bundle is written, a draft PR opens, and a reviewer runs `verify`.

## Roadmap
GitHub App with minimal permissions, an agent runner that consumes `unresolved.json`, AST-based transforms, more languages, a benchmark of recorded real breaking changes, and a provider adoption dashboard.

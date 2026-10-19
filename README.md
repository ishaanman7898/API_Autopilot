# API Autopilot

API Autopilot applies signed migration rules to a code repository and records exactly what it did. A publisher, such as an API provider or a library maintainer, writes a rule once and signs it. A consumer runs the rule on their own machine or CI, gets a change they can review, and gets an evidence bundle another person can replay.

It was built for breaking API changes. The rule format is not specific to APIs, so it also works for library upgrades, config keys and CLI flags. Matching is a real parse for JavaScript and TypeScript. Anything the tool cannot prove is never rewritten. It is queued for a person or an agent instead.

This is version 0.2. Read the limits section before you point it at a real repository.

Related docs are [overview](docs/overview.md) and [architecture](docs/architecture.md).

## Install

Node 20 or newer. The one runtime dependency is `typescript`, pinned to an exact version, which is used as a parser and symbol resolver.

```sh
git clone https://github.com/ishaanman7898/API_Autopilot.git
cd API_Autopilot
npm ci
node bin/apimigrate.js help
```

Related docs are [CLI reference](docs/cli.md).

## Quick start

A publisher creates keys, writes a rule file and signs it.

```sh
node bin/apimigrate.js keygen --out keys
node bin/apimigrate.js lint rules.json
node bin/apimigrate.js sign rules.json --key keys/apimigrate-private.pem
```

The publisher serves `keys/apimigrate-keys.json` at `https://<domain>/.well-known/apimigrate-keys.json`.

A consumer previews the change, applies it, and verifies it.

```sh
node bin/apimigrate.js apply --rules rules.json --well-known api.acme.com --dry-run
node bin/apimigrate.js apply --rules rules.json --well-known api.acme.com --test-cmd "npm test"
node bin/apimigrate.js verify --rules rules.json --evidence .apimigrate/evidence.json --root <base checkout> --head .
```

`examples/` has a rule file for an API, a rule file for a webpack config, and a small app to try them on.

Related docs are [rule format](docs/rule-format.md) and [evidence and replay](docs/evidence.md).

## What a run does

1. Checks the rule is valid, has not passed its sunset date, and is allowed by `.apimigrate.yml`.
2. Verifies the signature against keys the publisher published. Anything missing, expired, revoked or mismatched stops the run.
3. Parses the repository and applies each rule in order, in memory. Only call sites it can trace to the package are rewritten.
4. Runs the gate on the rewritten tree, which fails on removed or skipped tests, weakened assertions, new secrets, and edits to test or CI config. If it fails, nothing is written.
5. Writes the changes, runs your test command if you gave one, then runs the gate again, this time with coverage.
6. Writes `.apimigrate/evidence.json`, a queue of unresolved sites, and an audit log.

Related docs are [matching](docs/matching.md), [gate](docs/gate.md), [agent fallback](docs/agent.md) and [security](docs/security.md).

## Watching for new versions

`watch` finds dependencies with a new major version on npm, so nobody has to notice a release first. For each one it uses the provider's signed rules when the provider lists them at `/.well-known/apimigrate-rules.json`. Otherwise it drafts rules from the `api.md` files of the two releases on GitHub, or, when neither has one, from the TypeScript declarations in their npm tarballs. The Action's watch mode opens one draft pull request per upgrade. Drafted rules are titled `[unsigned draft]` and carry a warning that nobody has reviewed or signed them. When an upgrade fails your tests, its pull request still opens, titled `[tests failing]`.

```sh
node bin/apimigrate.js watch --dry-run
```

Related docs are [CLI reference](docs/cli.md#watch), [drafting rules](docs/draft.md) and [GitHub Action](docs/github-action.md).

## Commands

| Command | Purpose |
| --- | --- |
| `keygen` | Create an ed25519 key pair and a publishable key set. |
| `lint` | Validate a rule file. |
| `sign` | Sign a rule file. Refuses drafts. |
| `index` | Build the rule index a provider publishes for `watch`, from a folder of signed rule files. |
| `check` | Verify a rule file signature. |
| `draft` | Draft rules from two OpenAPI 3.x specs in JSON, or two SDK checkouts with `api.md`. |
| `apply` | Apply a signed rule and write evidence. Supports `--dry-run`. |
| `agent-apply` | Validate and apply agent output for unresolved sites, through the same gate. |
| `verify` | Replay a migration on a base checkout and compare it with the evidence. |
| `gate` | Run only the gate between two trees. |
| `watch` | Find dependencies with a new major version on npm, then fetch signed rules or draft unsigned ones. |

Exit codes are 0 for success, 1 for a gate, test or verify failure, 2 for a usage or config error, and 3 for a trust failure.

Related docs are [CLI reference](docs/cli.md) and [drafting rules](docs/draft.md).

## Configuration

Per repository settings live in `.apimigrate.yml`. Unknown settings and wrong types are errors.

```yaml
providers: [acme]
paths:
  - src
  - test
extensions: [.ts, .js]
pins:
  - 673148db71c5b71c19cefe2e60e96e2e06ea404cf3fe0ce48de0abdc78e07977
protect:
  - config/ci/**
allow:
  - jest.config.js
coverageTolerance: 0
```

Related docs are [CLI reference](docs/cli.md) and [gate](docs/gate.md).

## GitHub Action

The action runs `apply` on your runner, then opens a draft pull request with the evidence in the body and as an artifact. It never merges. The sample workflow asks for `contents: write` and `pull-requests: write` and nothing else.

Related docs are [GitHub Action](docs/github-action.md).

## Limits of v0

- Matching covers JavaScript and TypeScript only. It follows imports, requires, re-exports and local files. It has no type information, so a receiver that arrives as an untyped parameter of an exported function, an untyped class field that is not `readonly`, or a `let` variable that is also given other values cannot be proven and goes to the queue. A parameter typed with the SDK class is followed.
- A call in a file that neither imports the package nor reaches it through imports of other scanned files is not seen. In a file that does reach it, a call that looks right but cannot be proven is queued.
- Clients from factory functions, lazily cached variables, `globalThis` caches, CommonJS exports and `tsconfig.json` path aliases are followed. Object methods and class members are not. The [Mux benchmark](bench/mux-14-to-15/README.md) measures how many call sites the tool can see.
- `rename-dependency` updates `package.json`. With `--install`, which the Action uses, the new versions are installed before your tests and the lockfile is updated, without install scripts. Without it the lockfile is left alone, and the run output and the pull request say to regenerate it.
- The gate recognizes common JavaScript test styles. It counts per file, so it can flag legitimate test rewrites. The `allow` setting exists for that.
- Replay reproduces only the deterministic pass. Agent edits are checked by the head digests, the gate and your tests, not reproduced.
- Regex `replace` rules are not parse-verified and are labelled that way in the evidence.
- The test suite passes in CI on Linux, macOS and Windows with Node 20 and 22.
- The GitHub Action runs on a real runner in CI (`action-selftest` and `provider-selftest`), but those runs record the pull request command instead of opening one. `provider-selftest` reads signed rules from a live test domain. No SDK provider publishes rules yet.
- Keys are fetched from a well-known URL on each run. There is no transparency log. Consumers who want stronger guarantees should pin rule hashes or commit the key set.
- Secret detection is a list of patterns, not an entropy check. Prompt-injection stripping is a heuristic.
- Performance on very large repositories has not been measured. A 114-rule run takes under a second on a 265-file app and about 4 seconds on a monorepo.

Related docs are [security](docs/security.md), [matching](docs/matching.md), [build log](docs/history.md), [strategy](docs/strategy.md) and [plan](docs/plan.md).

## Project

Contributions are described in [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md). The license is [MIT](LICENSE).

Related docs are [security](docs/security.md) and [architecture](docs/architecture.md).

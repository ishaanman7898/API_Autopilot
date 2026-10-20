# Architecture

The core is a set of small modules that work on plain maps of path to text. The command files do the file reading, writing and printing. That keeps the engine usable on a CI runner, in another tool, or in a test with no disk.

## Flow of one migration

1. `commands/apply.js` loads the config and the rule, and checks sunset, provider, signature and pins.
2. `tree.js` reads the scan files and the gate files as LF text.
3. `engine.js` runs each rule in order. For code rules it builds a program with `parse.js`, resolves receivers with `bindings.js`, finds call sites with `match.js`, and asks `transforms.js` for edits. Edits are applied by position.
4. `tree.js` writes only the changed files, with their original line endings.
5. With `--typecheck`, `typecheck.js` type-checks the changed files before and after the rewrite. `gate.js` compares the before and after trees and adds the type errors the rewrite added.
6. `evidence.js` builds the bundle. `agent.js` builds the queue.

## Modules

| File | Role |
| --- | --- |
| `src/parse.js` | Builds an in-memory TypeScript program over the scanned files. |
| `src/bindings.js` | Traces an expression to an export of the package and returns its origin. |
| `src/match.js` | Lists module references and finds call sites, proven or lookalike. |
| `src/transforms.js` | One function per rule kind that returns edits or queues a site. |
| `src/engine.js` | Runs rules in order, applies edits by position, collects changes and unresolved sites. |
| `src/rule.js` | Rule validation, canonical JSON, hashing, sunset, signing blockers. |
| `src/signing.js` | Key generation, signing, and fail closed verification. |
| `src/keys.js` | Key set parsing, key files, and the bounded well-known fetch. |
| `src/tree.js` | Reads and writes trees with normalized text, sorted paths and no symlinks. |
| `src/evidence.js` | Evidence bundle, replay, and the head check. |
| `src/gate.js` | The gate checks and findings. |
| `src/typecheck.js` | Type-checks changed files with the repository's compiler options and installed packages, and compares the errors of the original and rewritten text. |
| `src/testscan.js` | Syntax based facts about test files. |
| `src/secrets.js`, `src/glob.js` | Secret patterns and glob matching. |
| `src/sanitize.js`, `src/agent.js` | Context cleaning and fencing, the queue, and agent result validation. |
| `src/diff.js` | OpenAPI 3.x diffing and rule drafting. |
| `src/apimd.js` | Reads `api.md` surfaces from a checkout or by fetching, diffs them, and drafts rules. |
| `src/net.js` | Bounded HTTPS reads of text and bytes for the watcher, with redirects only within a host when asked. |
| `src/dts.js` | Reads npm tarballs after checking their integrity, builds a surface from their TypeScript declarations, diffs two releases, and drafts rules. |
| `src/registry.js` | npm versions, version lines, and finding dependencies with a new major version. |
| `src/sources.js` | The `sources` setting and signed rule files from a provider's rule index. |
| `src/upstream.js` | Finds a release's source on GitHub and drafts rules from two releases, from `api.md` or else from declarations. |
| `src/config.js`, `src/args.js`, `src/errors.js`, `src/version.js` | Config parsing, flag parsing, exit codes, version. |
| `src/diffview.js`, `src/prbody.js` | Unified diffs and pull request text. |
| `src/commands/*.js` | One file per command. `common.js` holds the shared loaders. |
| `src/cli.js` | Dispatch, help and error mapping. |
| `scripts/pr.mjs` | Helper used by `action.yml`. |

## Design choices

- Rules run in order and each sees the previous output. A rule that changes nothing keeps the program, the resolver and its answers for the next rule. A rule that changes files gets a new program that reuses every unchanged source file. A test checks this gives the same result as rebuilding for every rule.
- Unproven means unchanged. The engine returns a reason for every site it declines.
- The gate and the evidence are separate from the engine so agent edits can go through them too.
- Exit codes separate a failed check from a trust failure, so automation can tell them apart.

## Roadmap

A GitHub App with narrow permissions, more languages, an agent runner that consumes the queue, and signed evidence bundles. None of these exist yet. A benchmark of recorded breaking changes has started in [bench](../bench/README.md), with one change so far.

Related docs are [matching](matching.md), [evidence and replay](evidence.md), [gate](gate.md) and [CLI reference](cli.md).

# Build log

## Version 0.1

A first prototype. It had a signed rule format, a regex based engine, a gate, an evidence bundle, a draft command and a CLI. Matching was by text, which produced false positives and false negatives, so it was not safe on a real repository.

## Version 0.2, the hardening branch

Work in order of priority.

1. Matching. Replaced regex with a TypeScript program and symbol resolution. Added fixtures for aliases, defaults, namespaces, destructuring, requires, re-exports, shadowing and more.
2. Trust. Split signing and key handling, added key windows and revocation, a bounded well-known fetch, hash pinning and fail closed behavior, with adversarial tests.
3. Evidence. Made the bundle deterministic and added replay and head checks.
4. Gate. Added skipped, weakened, commented and tautological test detection, protected file checks, and findings with file and line.
5. Agent. Added the sanitized queue, and `agent-apply` with the same gate.
6. Draft. Rewrote the OpenAPI diff for 3.x with confidence labels.
7. CLI. Split into one file per command, strict flags, exit codes, dry run and diffs.
8. Action. Draft pull requests only, safe input handling, evidence attached, sample workflow.
9. Docs and project files.

## Verified

The test suite runs with the Node test runner and covers each item above, including the end to end flows for apply, verify, drift, trust failures, usage errors, dry run, the gate and agent-apply. It passed on Windows with Node 25 when this was written, and now passes in CI on Linux, macOS and Windows with Node 20 and 22. One test is skipped on systems that cannot create symbolic links.

## Not verified

- The GitHub Action on a real runner.
- The well-known fetch against a live domain. It is tested with injected fetch functions.
- Performance on large repositories.
- Real third party SDK migrations beyond one. The [Mux 14 to 15 benchmark](../bench/mux-14-to-15/README.md) ran the tool on 32 public repositories: no new type errors, but 56% of call sites were invisible to it because of path aliases and factory functions. It type-checks only, and runs no tests.

Related docs are [architecture](architecture.md) and [security](security.md).

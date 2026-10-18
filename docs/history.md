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
10. Watcher. `watch` finds new major versions on npm, uses a provider's signed rules from its rule index, or else drafts unsigned rules from the `api.md` files of both releases on GitHub. The Action's watch mode opens one draft pull request per upgrade, with drafts marked unsigned in the branch, title and body.

## Verified

The test suite runs with the Node test runner and covers each item above, including the end to end flows for apply, verify, drift, trust failures, usage errors, dry run, the gate and agent-apply. It passed on Windows with Node 25 when this was written, and now passes in CI on Linux, macOS and Windows with Node 20 and 22. One test is skipped on systems that cannot create symbolic links.

## Not verified

- The GitHub Action opening a real pull request. It runs on a real runner in the `action-selftest` workflow, in both modes, which records the pull request call instead of making it.
- A provider's rule index on a live domain. No provider publishes one yet, so the signed path of `watch` is tested with injected fetch functions. The draft path runs against the real npm registry and GitHub in the selftest.
- The well-known fetch against a live domain. It is tested with injected fetch functions.
- Performance on very large repositories. On the Mux benchmark's largest monorepo a 114-rule run takes about 4 seconds.
- Real third party SDK migrations beyond one. The [Mux 14 to 15 benchmark](../bench/mux-14-to-15/README.md) ran the tool on 32 public repositories with rules drafted from the two SDKs: it fixed every type error the upgrade causes, introduced none, updated every `package.json`, and proved 98% of Mux call sites and queued the rest. A second benchmark, [Cloudflare 6 to 7](../bench/cloudflare-6-to-7/README.md), ran 254 drafted rules on 12 repositories with the same result: nothing broken, every `package.json` updated. It type-checks only, and runs no tests.

Related docs are [architecture](architecture.md) and [security](security.md).

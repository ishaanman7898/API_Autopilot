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

The signed path of `watch` runs against a live domain in the `provider-selftest` workflow. `https://atomicayush.github.io`, a test provider on a team member's GitHub Pages site, serves a rule index built with `index`, its key set and a signed rule file for Mux 14 to 15. On a real runner, the Action's watch mode fetches all three over HTTPS, verifies the signature against that key set, and asks for one signed draft pull request whose branch passes `npm ci` and `npm test`. The key set fetch is the one `--well-known` uses.

The Action opened a real draft pull request once, by hand, at commit `74be924`. The CI selftests record the `gh pr create` call instead of making it. A private throwaway repository held the Mux 14 consumer from `action-selftest` and ran watch mode with the default workflow token. The first run failed because the repository did not allow GitHub Actions to open pull requests, a setting that was off by default. The action deleted the branch it had pushed. With the setting on, the next run opened a draft titled `[unsigned draft] API migration: @mux/mux-node 14.1.1 to 15.5.0`. Its body had the unsigned warning, the drafted rules, the lockfile note and passing tests, and it changed only `package.json`, `package-lock.json` and `src/video.ts`. A third run skipped the upgrade because its branch existed, and nothing was merged.

## Not verified

- The GitHub Action opening a real pull request in CI. The selftests record the call, and the real pull request above was a one-off check by hand. Apply mode has not opened a real one.
- A rule index on an SDK provider's own domain. No provider publishes one yet, so the live check uses a test domain whose rules were drafted from the Mux SDKs, not published by Mux.
- Performance on very large repositories. On the Mux benchmark's largest monorepo a 114-rule run takes about 4 seconds.
- Real third party SDK migrations beyond one. The [Mux 14 to 15 benchmark](../bench/mux-14-to-15/README.md) ran the tool on 32 public repositories with rules drafted from the two SDKs: it fixed every type error the upgrade causes, introduced none, updated every `package.json`, and proved 98% of Mux call sites and queued the rest. A second benchmark, [Cloudflare 6 to 7](../bench/cloudflare-6-to-7/README.md), ran 254 drafted rules on 12 repositories with the same result: nothing broken, every `package.json` updated. It type-checks only, and runs no tests.

Related docs are [architecture](architecture.md) and [security](security.md).

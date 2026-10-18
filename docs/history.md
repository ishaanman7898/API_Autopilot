# Build log

What was built, in order, from the research and build plan.

1. Scaffold, MIT license, `.gitignore`
2. Signed rule format and ed25519 signing (`src/rule.js`)
3. Untrusted-text and secret scanners (`src/sanitize.js`)
4. Deterministic rewrite engine with agent fallback queue (`src/engine.js`)
5. Assertion, coverage and secret gate (`src/gate.js`)
6. Evidence bundle and replay (`src/evidence.js`)
7. Draft rules from OpenAPI diffs (`src/diff.js`)
8. `.apimigrate.yml` parser (`src/config.js`)
9. CLI (`src/cli.js`, `bin/apimigrate.js`)
10. Tests, example app and rule file, GitHub Action, README
11. Generalised beyond APIs: `scope: any`, `replace` rules, configurable `extensions`, webpack example, this documentation

## Verified
Unit tests cover signing and tamper detection, validation, engine rewrites and fallback queue, the gate, evidence replay, spec diffing, config parsing, and the universal replace rule. The CLI was run end to end on the sample app (keygen, sign, check, apply, verify).

## Not built or not checked
GitHub App, provider dashboard, benchmark of real breaking changes, an agent runner, the `--well-known` fetch against a live domain, and the GitHub Action in a real workflow. Claims in the original brief that need sourcing (the AWS downtime statistic, the Stainless customer list, whether SDK regeneration changes public surface) were not investigated.

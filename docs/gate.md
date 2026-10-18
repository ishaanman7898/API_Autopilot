# Gate

The gate compares the tree before and after a migration and fails when something suggests the tests were made to pass instead of the code being migrated. It runs on deterministic edits and on agent edits, with the same rules. Each finding names a code, a file and a line.

## Checks

| Code | Trips when |
| --- | --- |
| `test-removed` | A test file that existed in the base is gone. |
| `assertions-dropped` | A test file has fewer assertions than before. |
| `assertions-dropped-total` | The total across test files fell. |
| `test-skipped` | A skipped, todo or focused test was added. Covers `skip`, `todo`, `only`, `xit`, `xdescribe`, `fit`, and `{ skip: true }`. |
| `assertion-weakened` | A weak assertion was added. Covers `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toBeUndefined`, `assert.ok`, `assert(x)`, `expect.anything()` and `expect.any()`. |
| `assertion-empty` | `expect(x)` appears with no matcher. |
| `assertion-tautology` | An assertion is made on a literal, such as `expect(true).toBe(true)`. |
| `assertion-commented` | An assertion or test call appears in a comment that was not there before. |
| `protected-changed` | A protected file was added, changed or removed. |
| `coverage-dropped` | Line coverage fell by more than `coverageTolerance`. |
| `coverage-missing` | Base coverage was given and head coverage was not. |
| `secret-added` | An added line matches a secret pattern. The value is never printed. |

Assertions are found in the syntax tree, so comments and strings never count.

## Protected files

By default the gate watches CI and test configuration. That includes `.github/workflows/**`, `.gitlab-ci.yml`, `.circleci/**`, `azure-pipelines.yml`, `Jenkinsfile`, codecov files, and the config files of jest, vitest, karma, playwright, cypress, mocha, ava, nyc and c8. In `package.json` it watches the `test`, `pretest`, `posttest` and `coverage` scripts and the `jest`, `vitest`, `c8`, `nyc`, `mocha` and `ava` sections. Other changes to `package.json` are allowed.

Add more with `protect` in `.apimigrate.yml`. Exempt a path with `allow`. Globs support `*`, `**` and `?`.

## Messages

Each message says what tripped and where.

```
test/billing.test.ts: assertions dropped from 2 to 1
test/billing.test.ts:12: skipped, todo or focused test added
test/billing.test.ts:3: weak assertion added (truthiness, definedness or anything)
.github/workflows/ci.yml:2: protected test or CI file changed
src/config.ts:5: added line looks like a aws-access-key
```

## Coverage

Pass `--cov-base` and `--cov-head` with `coverage-summary.json` files from istanbul. The tool does not run coverage itself.

## Limits

- It recognizes `expect`, `assert`, `.should`, supertest style `.expect(` and ava `t.` assertions. Other styles are not counted.
- Counts are per file. Moving assertions between files, or rewriting a test completely, can trip it. Use `allow` for those cases.
- It cannot judge whether a changed expected value is correct.
- Secret detection is a list of patterns for common token formats. It is not an entropy check and will miss custom secrets.
- It reads test and CI files only. Mocks that hide a failure in non-test files are not detected.

Related docs are [agent fallback](agent.md), [CLI reference](cli.md) and [security](security.md).

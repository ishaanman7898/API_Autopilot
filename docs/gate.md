# Gate

The gate compares the tree before and after a migration and fails when something suggests the tests were made to pass instead of the code being migrated. It runs on deterministic edits and on agent edits, with the same rules. Each finding names a code, a file and a line.

Edits are gated in memory before anything is written, so a change that fails the gate never reaches the disk. `apply` runs the gate a second time after your test command, because the test command can change files too. With `--typecheck` that second gate also fails on type errors the rewrite added, which needs the new versions installed. See [type check](#type-check).

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
| `type-error-added` | With `apply --typecheck`, a changed code file has a type error on a line the rewrite changed that the original text did not have. |

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

## Type check

`apply --typecheck` needs `--install` or `--install-cmd`, and is refused without them, because until the new versions are installed a check says nothing about them. It type-checks every code file whose text the run changed, three times:

1. Right before the install, the original text with the versions installed then, usually the old ones.
2. After the install and your test command, the original text with the new versions. These are the errors the upgrade causes without a migration.
3. Then the rewritten text, as the tests left it, with the new versions.

Runs 2 and 3 see the same `node_modules`, so a dependency that is not installed breaks both alike. Run 1 is there because the upgrade can hide an error. When a call already passed a wrong key with the old version, the new version may report only its argument count. The rewritten call then shows the wrong key again, and that error is not the rewrite's.

Options come from the nearest `tsconfig.json` or `jsconfig.json` at or above each file, with its `extends`, `strict`, `paths`, `lib` and `types`. When that config does not list the file, as in a Vite `tsconfig.json` that only has `references`, the first referenced config that lists it is used. The declaration files the config lists are loaded too, for globals. A file that no config covers gets ESNext defaults with `strict` off, and JavaScript is then checked only when the file has `// @ts-check`. Nothing is emitted, and `composite` and `incremental` are off. TypeScript is the version apimigrate ships, 5.9, run as a library, so no code from the repository runs.

A rewrite can join or split lines. So errors on the lines it changed are compared hunk by hunk, by TypeScript code and message, and errors on other lines are compared after their line is mapped back through the hunks before it. An error belongs to a hunk when its span touches the hunk's lines.

- An error on a changed line that neither run of the original text has is a `type-error-added` finding, so the run fails. The message names the file, the line in the rewritten file, the code and the message, as in `src/kv.ts:6: type error added: TS2698 Spread types may only be created from object types.`
- A new error on a line the rewrite did not change is printed as a note, recorded in the evidence and listed in the pull request, but is not a finding. Such errors are usually upgrade breaks that an error in the original text hid. For example, the original imported a name the new version removed, so everything typed through it was `any`.

The evidence records the result under `typecheck`. When no `package.json` changed, the install failed or `--dry-run` was given, nothing new was installed. The check is then skipped with a note, and `typecheck` is `{ ran: false, reason }`. If TypeScript throws, the run prints a warning and records the reason, and the gate does not fail because of it.

The Action passes `--typecheck` whenever it installs. Set its `typecheck` input to `false` to turn it off.

A script outside the benchmark ran these three checks on the base and migrated trees of the [Cloudflare argument benchmark](../bench/cloudflare-6-to-7-args/README.md), with `cloudflare@6.5.0` and then `7.0.0` installed, on the 46 repositories where the run changed code. On the first run's trees it reported 6 errors in 4 repositories. These were the 4 faulty rewrites of finding 2 and 2 of its 5 `strict`-only TS2783 rewrites. On the rerun's trees it reported none, and printed 5 notes in 2 repositories. Runs 2 and 3 took 0.6 s per repository at the median and 2.4 s at most.

## Coverage

Pass `--cov-base` and `--cov-head` with `coverage-summary.json` files from istanbul. The tool does not run coverage itself.

## Limits

- It recognizes `expect`, `assert`, `.should`, supertest style `.expect(` and ava `t.` assertions. Other styles are not counted.
- Counts are per file. Moving assertions between files, or rewriting a test completely, can trip it. Use `allow` for those cases.
- It cannot judge whether a changed expected value is correct.
- Secret detection is a list of patterns for common token formats. It is not an entropy check and will miss custom secrets.
- It reads test and CI files only. Mocks that hide a failure in non-test files are not detected.
- The type check counts errors on changed lines only. A rewrite that breaks a line it did not touch, for example by changing the type a call returns, shows up as a note. pebble-api's TS2353 in finding 2 of the Cloudflare argument benchmark is one: the old params object stayed on its own lines and became the options argument.
- An error on a changed line that the upgrade itself causes, and that both runs of the original text hid, still fails the run.
- The type check reads `tsconfig.json` and `jsconfig.json` only. A Deno project with only `deno.json` gets the defaults, so its `strict`-only errors are missed. That is how it missed sparql-agent's 3 TS2783 errors in the benchmark.
- The type check uses TypeScript 5.9, not the repository's own version. A newer option it does not know is ignored, for the original text as for the rewrite.

Related docs are [agent fallback](agent.md), [CLI reference](cli.md) and [security](security.md).

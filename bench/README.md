# Benchmarks

Each folder holds one recorded breaking change: a rule file for it and the results of running it on real public repositories.

| Folder | Change | Repositories |
| --- | --- | --- |
| [mux-14-to-15](mux-14-to-15/README.md) | `@mux/mux-node` 14 to 15 (`@mux/ts`) | 32 |
| [cloudflare-6-to-7](cloudflare-6-to-7/README.md) | `cloudflare` 6 to 7 (named path parameters) | 12 |

## How a benchmark runs

`run.mjs` clones each repository shallowly, applies the signed rule file to a copy with `apimigrate apply`, and type-checks four trees, compared by file, line and error code.

| Tree | Code | SDK installed | Answers |
| --- | --- | --- | --- |
| A | original | old version | Baseline. Its errors are ignored. |
| B | original | new version | What upgrading without migrating breaks. |
| C | migrated | every package in `--new` | What is still broken after apimigrate, and what it broke. |
| D | migrated | only the first package in `--new` | What breaks if `package.json` is left as it was. |

The repositories are untrusted. Nothing in them is installed or run, so no tests run. Only the SDK packages are installed, once, into a shared `node_modules` that every clone resolves through. Other dependencies are missing in every tree, so their errors cancel out in the comparison.

`coverage.mjs` dry-runs one `manual` rule per SDK method on the same clones and compares what the tool reports with a text search for each method, to count call sites the tool cannot see at all.

## Running one

The clones and results go in a work folder outside the repository.

```sh
node bench/run.mjs --rules bench/mux-14-to-15/rules.json --repos repos.json --work ../bench-work \
  --old @mux/mux-node@14.1.1 --new @mux/mux-node@15.5.0,@mux/ts@15.5.0
node bench/report.mjs ../bench-work/results.json
node bench/coverage.mjs --calls calls.json --package @mux/mux-node --work ../bench-work
```

`repos.json` is a list of `{ "repo": "owner/name", "commit": "..." }`; the commit is optional and pins the checkout. `--types` names packages, such as `@types/node@22`, that are installed and loaded with both SDK versions. `calls.json` is a list of method paths such as `"video.assets.create"`.

Related docs are [architecture](../docs/architecture.md) and [build log](../docs/history.md).

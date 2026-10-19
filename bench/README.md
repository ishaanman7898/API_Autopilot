# Benchmarks

Each folder holds one recorded breaking change: a rule file for it and the results of running it on real public repositories.

| Folder | Change | Repositories |
| --- | --- | --- |
| [mux-14-to-15](mux-14-to-15/README.md) | `@mux/mux-node` 14 to 15 (`@mux/ts`) | 32 |
| [cloudflare-6-to-7](cloudflare-6-to-7/README.md) | `cloudflare` 6 to 7 (named path parameters) | 12 |
| [orb-5-to-6](orb-5-to-6/README.md) | `orb-billing` 5 to 6 | 3 |
| [cloudflare-6-to-7-args](cloudflare-6-to-7-args/README.md) | `cloudflare` 6 to 7, on code that calls the methods whose arguments changed | 67 |

## How a benchmark runs

`run.mjs` clones each repository shallowly, applies the signed rule file to a copy with `apimigrate apply`, and type-checks four trees, compared by file, line and error code.

| Tree | Code | SDK installed | Answers |
| --- | --- | --- | --- |
| A | original | old version | Baseline. Its errors are ignored. |
| B | original | new version | What upgrading without migrating breaks. |
| C | migrated | every package in `--new` | What is still broken after apimigrate, and what it broke. |
| D | migrated | only the first package in `--new` | What breaks if `package.json` is left as it was. |

The repositories are untrusted. Nothing in them is installed or run, so no tests run. Only the SDK packages are installed, once, into a shared `node_modules` that every clone resolves through. Other dependencies are missing in every tree, so their errors cancel out in the comparison. The exception is modules the old SDK itself depends on, which resolve only in tree A: in [cloudflare-6-to-7-args](cloudflare-6-to-7-args/README.md) that adds 32 TS2307 errors for `node-fetch`, `ms`, `form-data` and `mime-types` to the upgrade count.

`coverage.mjs` dry-runs one `manual` rule per SDK method on the same clones and compares what the tool reports with a text search for each method, to count call sites the tool cannot see at all.

With `--receiver-types`, `coverage.mjs` also compares each proof with the type the full TypeScript checker gives the call's root receiver. It opens every base checkout with `strict`, `allowJs`, `skipLibCheck` and `moduleResolution` `bundler`, the new SDK that `run.mjs` leaves in the shared `node_modules`, and the path aliases of the nearest `tsconfig.json` or `jsconfig.json`. The root receiver is what is left of the callee once the trailing segments of the method path are taken off, such as `client` in `client.video.assets.create()`, or `video` in `video.uploads.create()` when `video` was destructured from the client. Receivers whose type is a class the SDK package declares, such as the client or one of its resources, are counted, and the rest, such as `any`, `unknown` or a type from another package, are listed. The type-checks above only exercise calls that a rule rewrites, so a wrong proof for a method no rule changes would go unseen there. Where a proof comes from a type annotation, such as a parameter typed as the client, the checker reads the same annotation, so the two agree by construction.

A listed call is not always a wrong proof, so each one is read by hand. The checker types an untyped JavaScript parameter as `any`, even where the tool follows the parameter through every call of a local function. It also types as `any` a client built with `new` on a CommonJS export that the SDK's type declarations give no construct signature, and a JavaScript `let` declared as `null`, assigned later and read in another function. In [cloudflare-6-to-7](cloudflare-6-to-7/README.md), [mux-14-to-15](mux-14-to-15/README.md) and [cloudflare-6-to-7-args](cloudflare-6-to-7-args/README.md) the tool proves 42, 159 and 188 calls, 389 in all. The checker types 380 of their receivers as an SDK class and 9 as `any`, each for one of those three reasons, and reading the code shows those 9 proofs are right.

## Running one

The clones and results go in a work folder outside the repository.

```sh
node bench/run.mjs --rules bench/mux-14-to-15/rules.json --repos repos.json --work ../bench-work \
  --old @mux/mux-node@14.1.1 --new @mux/mux-node@15.5.0,@mux/ts@15.5.0
node bench/report.mjs ../bench-work/results.json
node bench/coverage.mjs --calls calls.json --package @mux/mux-node --work ../bench-work --receiver-types
```

`repos.json` is a list of `{ "repo": "owner/name", "commit": "..." }`; the commit is optional and pins the checkout. `--types` names packages, such as `@types/node@22`, that are installed and loaded with both SDK versions. `calls.json` is a list of method paths such as `"video.assets.create"`.

Related docs are [architecture](../docs/architecture.md) and [build log](../docs/history.md).

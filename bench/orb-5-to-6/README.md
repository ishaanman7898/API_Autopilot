# Orb 5 to 6

`orb-billing` 6 moved the SDK to Stainless's second TypeScript architecture. It renamed methods and namespaces that end in `Id`, such as `customers.fetchByExternalId` to `customers.fetchByExternalID`, moved the leading path parameter of 7 methods into the params object, switched to the built-in `fetch` with no dependencies, and changed internal types and error classes. Orb ships no migration guide.

[rules.json](rules.json) is the [Orb kit](../../providers/orb/README.md): 23 rules that `apimigrate draft` produces from the `api.md` files of 5.76.0 and 6.0.0, with the review marks and evidence notes removed and the id, version range and sunset set by hand. There are 11 `rename-method` rules, 4 `rename-namespace` rules, 7 `positional-to-named` rules and a `rename-dependency` to `^6.0.0`.

The 3 repositories are every distinct public codebase found calling the client while on version 5, in October 2026. Code search found 17 `package.json` files in 16 repositories that name `orb-billing`, and GitHub's dependency graph lists 26 dependents. Most are forks or copies of Nango or of orb-sync-engine, three projects are on version 4 and one on version 1. Two more name version 5 without code that uses it: the `hookdeck/webhook-skills` examples declare it but never import it, and `stroland02/Sync` has it in a test fixture. The 3 benchmarked repositories are listed with their commits in [repos.json](repos.json).

- [NangoHQ/nango](https://github.com/NangoHQ/nango) pins `5.48.0` in its billing package.
- [supabase/orb-sync-engine](https://github.com/supabase/orb-sync-engine) moved to 6.19 in September 2026. It is pinned to `e59b2a3`, the commit that moved it to `^5.48.0`. Its own upgrade in `43252c0`, 15 commits later, is a migration done by hand to compare with, made on code that had changed in between.
- [ausdisau/mapableau-new](https://github.com/ausdisau/mapableau-new) imports the package in 3 files, and its lockfile resolves 5.46.0, but only the legacy `package.replit.json` declares it (`^5.46.0`). No `package.json` does.

The run uses the engine (`src/`) at commit `04dd1ba`, unchanged on main, with `bench/run.mjs` and `bench/coverage.mjs` as committed in `5d97635`, and `orb-billing` 6.28.0, the version `^6.0.0` installs, and installs `@types/node` with both versions, because version 5 brought it in as a dependency and version 6 does not. Raw output is in [results.json](results.json) and [coverage.json](coverage.json). See [how a benchmark runs](../README.md) for the method.

## Findings

1. **The rules fix 4 of the 13 errors the upgrade causes, and break nothing. The other 9 are left without a word.** Upgrading breaks the type-check in all 3 repositories. The 4 fixed errors are the renamed `customers.fetchByExternalId` and `customers.updateByExternalId` calls in Nango. There are no new type errors and no gate failures. But no rule covers the other 9, and the tool queued nothing, so a pull request from this kit would show green rewrites and still fail to type-check in Nango and orb-sync-engine. mapableau-new gets no rewrite and no `package.json` change, so the kit would not upgrade it at all. Its 3 errors appear only when version 6 is installed by hand.
2. **What no rule covers.**
   - 5 errors in a Nango unit test that builds errors such as `new Orb.BadRequestError(400, body, 'bad', {})`. Version 5 took the headers as a plain record. Version 6 takes a Fetch `Headers` object, so `{}` must become `new Headers()`.
   - 1 error in orb-sync-engine, `import type { HeadersLike } from 'orb-billing/core'`. Version 6 has no `orb-billing/core` entry point and moved `HeadersLike` to `internal/headers`, which the package does not export. Supabase's own upgrade deleted the import and wrote the type out as `Record<string, string | string[] | undefined>`. `api.md` does not list it, so the draft could not see it.
   - 3 errors in mapableau-new, `webhooks.unwrap(...) as Record<string, unknown>`. Version 5 returned `Object` and a later 6.x release returns a union of webhook event types, which this cast no longer fits. Run against 6.0.0, these 3 do not appear and 6 errors remain.
3. **Only 3 of the 23 rules ran on real code.** `rename-customers.fetchByExternalId`, `rename-customers.updateByExternalId` and `dependency` fired, and each rewrite was correct. The 6 sites rewritten in the results are 4 calls in Nango's Orb client and 2 `package.json` version edits. The other 9 `rename-method` rules, the 4 `rename-namespace` rules and the 7 `positional-to-named` rules matched nothing, so this run says nothing about them.
4. **The dependency rule loosens an exact pin.** Nango pins `"orb-billing": "5.48.0"` exactly, and the rule writes `^6.0.0`. orb-sync-engine is updated as it should be. mapableau-new gets no update, because no `package.json` declares the package. The undeclared imports in the table below were all undeclared before the migration: a Nango script, an orb-sync-engine test and the three mapableau-new files.
5. **The tool sees every Orb call in the sample to a method in `api.md`, and proves 94% of them.** A probe with one `manual` rule per method in the 5.76.0 `api.md` (139 methods) found 80 calls by text search. 18 are Stripe calls with the same method names, such as `stripe.customers.create`, and the tool rightly ignores them. The probe does not cover 5 calls to webhook helpers that `api.md` does not list: 3 to `webhooks.unwrap` in mapableau-new and 2 to `webhooks.verifySignature` in Nango and orb-sync-engine.

   | | Proven | Queued | Invisible |
   | --- | ---: | ---: | ---: |
   | Orb calls | 58 (94%) | 4 (6%) | 0 |

   The 4 queued calls are in a Nango script that types its client with a hand-written `ScheduleClient` interface instead of the SDK class.
6. **Large repositories are slow.** Apply took 23 s on Nango (3,058 code files) and 7 s on mapableau-new (4,926), against a 1.2 s median for Mux. File count alone does not explain it, since mapableau-new has more files and applies about 3 times faster. An earlier run before commit `48dd84a`, which made the resolver index global writes once, took 36 s and 22 s. Its output was not kept.

## What to build next

- Draft rules or queue prompts for subpaths that disappear from the package's `exports`, such as `orb-billing/core`.
- Queue `new` expressions of SDK classes whose constructor changed, such as the error classes.
- Keep an exact version pin exact when `rename-dependency` updates it.
- Make apply faster on large programs such as Nango.
- Run again when more public code uses the methods the other 20 rules cover.

## Results

Rule file `bench/orb-5-to-6/rules.json`, old SDK `orb-billing@5.76.0`, new SDK `orb-billing@6.28.0`, also installed `@types/node@22`, run 2026-10-19.

| | |
| --- | --- |
| Repositories | 3 |
| Benchmarked | 3 (0 skipped: none) |
| Sites rewritten (imports and calls) | 6 in 3 files |
| &nbsp;&nbsp;by `rename-customers.fetchByExternalId` | 2 |
| &nbsp;&nbsp;by `rename-customers.updateByExternalId` | 2 |
| &nbsp;&nbsp;by `dependency` | 2 |
| Sites queued for a person or agent | 0 |
| Gate failures | 0 |
| Repos where upgrading breaks the type-check | 3 of 3 |
| Type errors caused by upgrading without migrating | 13 |
| ... fixed by apimigrate | 4 |
| ... still present after apimigrate | 9 |
| New type errors introduced by apimigrate | 0 |
| package.json files updated | 2 in 2 repos |
| Repos with an SDK import its package.json does not declare | 3 of 3 (5 files) |
| Repos where the SDK resolved in the baseline type-check | 3 of 3 |
| Median apply time | 7233 ms |

### Per repository

| Repository | Rewritten | Queued | Upgrade breaks | Still broken | Added by migration |
| --- | ---: | ---: | ---: | ---: | ---: |
| [NangoHQ/nango](https://github.com/NangoHQ/nango/tree/8da524eae1a41ca3be1625b41d254a25fe34f3ca) | 5 | 0 | 9 | 5 | 0 |
| [ausdisau/mapableau-new](https://github.com/ausdisau/mapableau-new/tree/5a41cddfc95bc4cbe1daab20fbf1f82411a6e061) | 0 | 0 | 3 | 3 | 0 |
| [supabase/orb-sync-engine](https://github.com/supabase/orb-sync-engine/tree/e59b2a3e292b69aaa09b93fd7298f8c2b89fab40) | 1 | 0 | 1 | 1 | 0 |

### Type errors still present after migration, by kind

- type mismatch: 5
- TS2352: 3
- TS2307: 1

### Why sites were queued

- none

## Reproducing

```sh
node bench/run.mjs --rules bench/orb-5-to-6/rules.json --repos bench/orb-5-to-6/repos.json --work ../bench-work \
  --old orb-billing@5.76.0 --new orb-billing@6.28.0 --types @types/node@22
node bench/report.mjs ../bench-work/results.json
node bench/coverage.mjs --calls bench/orb-5-to-6/calls-5.json --package orb-billing --work ../bench-work
```

The rule file can be drafted again with `apimigrate draft` from a checkout of [orb-node](https://github.com/orbcorp/orb-node) at `v5.76.0` and one of [orb-typescript](https://github.com/orbcorp/orb-typescript) at `v6.0.0`. `calls-5.json` lists the methods in the 5.76.0 `api.md`.

Related docs are [benchmarks](../README.md), [matching](../../docs/matching.md) and [build log](../../docs/history.md).

# Mux 14 to 15

`@mux/mux-node` 15 renamed the package to `@mux/ts`, renamed `client.robotsPreview` to `client.robots`, removed `client.data.filters`, and moved some type declarations. The full list is in Mux's [migration guide](https://github.com/muxinc/mux-ts/blob/v15.0.0/MIGRATION.md).

[rules.json](rules.json) holds six rules, which are what `apimigrate draft` produces from the 14.1.1 and 15.0.0 SDK checkouts, with the review marks removed: a `rename-import` for the `resources/robots-preview` subpath, a `rename-import` to `@mux/ts`, a `rename-namespace` from `robotsPreview` to `robots`, a `rename-namespace` from the type namespace `RobotsPreview` to `Robots`, a `manual` rule for `data.filters.listValues` that names `data.dimensions.listValues` as the likely replacement, and a `rename-dependency` to `@mux/ts` `^15.0.0`. The type rule was written by hand at first. `draft` now reads it from the `api.md` headings that hold the renamed methods, `# RobotsPreview` in 14.1.1 and `# Robots` in 15.0.0. The first version of this benchmark used 16 hand-written rules.

The 32 repositories are every public GitHub repository that code search found pinning `@mux/mux-node` 14 in October 2026, out of 391 it found importing the package. They are listed with their commits in [repos.json](repos.json). Raw output from the latest run is in [results.json](results.json) and [coverage.json](coverage.json). See [how a benchmark runs](../README.md) for the method.

## Findings

1. **Every error the upgrade causes is now fixed, and nothing new breaks.** Upgrading breaks the type-check in 1 repository of 32, XAct1HP/10kp, with 4 errors: three `mux.robotsPreview.jobs.*` calls on a client from a `getMuxClient()` factory, and a JSDoc `import("@mux/mux-node/resources/robots-preview/...")` type. Version 0.2 fixed none of them and reported 0 unresolved. Now all 4 are fixed, with no new type errors and no gate failures in any repository.
2. **Builds no longer break on the package rename.** Version 0.2 rewrote the imports to `@mux/ts` but left `package.json` depending on `@mux/mux-node`, so all 32 migrated repositories failed to resolve the package. `rename-dependency` now updates 34 `package.json` files across the 32 repositories, and every SDK import in the migrated code is declared. Lockfiles still need regenerating, which the run output and the pull request say.
3. **Package names in plain strings are queued.** `vi.mock('@mux/mux-node', ...)` in a test and `serverExternalPackages` in a Next.js config would break silently if renamed blindly. Both are queued for a person.
4. **The tool now sees every Mux call in the sample and proves 98% of them.** A probe with one `manual` rule per Mux method found 156 Mux calls by text search.

   | Version | Proven | Queued | Invisible |
   | --- | ---: | ---: | ---: |
   | 0.2 | 25 (16%) | 44 (28%) | 87 (56%) |
   | with `tsconfig` path aliases | 32 (21%) | 44 (28%) | 80 (51%) |
   | with `export default <name>` followed | 56 (36%) | 44 (28%) | 56 (36%) |
   | with factory functions, lazy caches, and lookalikes queued in files that reach the package | 126 (81%) | 29 (19%) | 1 (1%) |
   | with CommonJS exports and `globalThis` caches | 136 (87%) | 20 (13%) | 0 |
   | with clients passed as parameters or held in class fields | 153 (98%) | 3 (2%) | 0 |
   | with methods, getters and object literal members, and callbacks a local method calls | 153 (98%) | 3 (2%) | 0 |

   The 3 calls still queued build their client from a constructor loaded with a dynamic `import()` at run time, which cannot be proven without running the code. No Mux call in the sample gets its client from a method, getter, object literal or callback, so following those changed nothing here. It did slow the probe on Docaari/GrindfyManager, a 2,705-file app with many `window.x` reads, until global-object writes and identifiers were indexed once per run. With that, the 114-rule probe there takes less than half the CPU time it took before methods were followed, with identical output.

   `coverage.mjs --receiver-types` compares each proof with the type the full TypeScript checker gives the call's root receiver, with `@mux/mux-node` 15.5.0 installed. The tool proves 159 calls: the 153 above, 3 in Javaris500/allan-palmer whose method chain is split over two lines, and 3 in nayyarsatwik30/CollabCut on `video`, which its `lib/mux.ts` destructures from the client with `export const { video } = mux`. The text search tests one line at a time and needs a `.` before the first segment, as in `.video.uploads.create(`, so it counts neither, and a call in either form that the tool did not see would not be counted as invisible. The checker types 152 of the root receivers as `Mux` and the 3 `video` receivers as `Video`, a resource class of the SDK. The other 4 are `any`, and reading the code shows their proofs are right. Three are `mux` in two controllers of Pritam-Kundu/EduSmart, which does `const Mux = require('@mux/mux-node')` and then `const mux = new Mux({ ... })`. In 15.5.0 the package's CommonJS export is a function that returns a new client, so `mux` is the client at run time. The type declarations give that export no construct signature, so the checker types `mux` as `any`. The fourth is `mux` at `app/api/webhooks/mux/route.js:91` in XAct1HP/10kp, an untyped parameter of the local function `ensurePlaybackId(mux, ...)`, whose only call passes the client that `getMuxClient()` returns. Without each repository's path aliases, the checker lists 67 more receivers as `any`: 58 `mux`, 6 `getMux()` and 3 `video`, all reached through aliases such as `@/lib/mux`.
5. **Large rule sets are fast.** The 114-rule probe used to rebuild the program for every rule and took 131 s on the largest repository. Reusing the program between rules and caching resolver answers brought it to 3.8 s with identical output. The median apply time with the six rules is about 1.2 s.
6. **Type names are renamed where they can be traced, and the sample has none to rename.** `rename-namespace` now also renames its path in type names such as `Mux.RobotsPreview.JobStatus`, `typeof client.robotsPreview` and JSDoc types, and in names imported from the package, such as `import type { RobotsPreview }`. The only robots-preview type in the 32 repositories is the JSDoc `import()` in XAct1HP/10kp, which the subpath rule already moved. So the sixth rule rewrote nothing, and the results with five and six rules are the same as before: 4 errors fixed, none introduced, and 153 of 156 calls proven with 3 queued.

## What to build next

- Draft rules for types that are gone. 15.0.0 drops `ExportsResponse`, `AssetCreateStaticRenditionResponse` and the `Data.Filters` types `FilterValue` and `FiltersResponse`, and `draft` only lists them in the report. Replacements, such as `VideoViewExportsResponse` for `ExportsResponse` and `StaticRendition` for `AssetCreateStaticRenditionResponse`, are not confirmed.

Done since the first run: `tsconfig.json` and `jsconfig.json` path aliases, `export default <name>`, factory functions and lazy caches, queueing lookalikes in files that reach the package, CommonJS `require` and `module.exports`, `globalThis` caches, typed and untyped parameters, class fields, JSDoc `import()` types, `rename-dependency`, `rename-namespace`, type names, drafting from `api.md`, drafting renamed type namespaces, and program reuse between rules.

## Results

Rule file `bench/mux-14-to-15/rules.json`, old SDK `@mux/mux-node@14.1.1`, new SDK `@mux/mux-node@15.5.0, @mux/ts@15.5.0`, run 2026-10-19.

| | |
| --- | --- |
| Repositories | 32 |
| Benchmarked | 32 (0 skipped: none) |
| Sites rewritten (imports and calls) | 96 in 92 files |
| &nbsp;&nbsp;by `dependency` | 34 |
| &nbsp;&nbsp;by `package-rename` | 58 |
| &nbsp;&nbsp;by `namespace-robotsPreview` | 3 |
| &nbsp;&nbsp;by `move-resources-robots-preview` | 1 |
| Sites queued for a person or agent | 2 |
| Gate failures | 0 |
| Repos where upgrading breaks the type-check | 1 of 32 |
| Type errors caused by upgrading without migrating | 4 |
| ... fixed by apimigrate | 4 |
| ... still present after apimigrate | 0 |
| New type errors introduced by apimigrate | 0 |
| package.json files updated | 34 in 32 repos |
| Repos with an SDK import its package.json does not declare | 0 of 32 (0 files) |
| Repos where the SDK resolved in the baseline type-check | 32 of 32 |
| Old package names left in code after migration | 2 files |
| Median apply time | 1157 ms |

### Per repository

| Repository | Rewritten | Queued | Upgrade breaks | Still broken | Added by migration |
| --- | ---: | ---: | ---: | ---: | ---: |
| [19leva89/react-ts-next-newtube](https://github.com/19leva89/react-ts-next-newtube/tree/3707c471f9d7b4765e404278d27c26773681d9d8) | 3 | 0 | 0 | 0 | 0 |
| [1outsyde/outsyde-backend](https://github.com/1outsyde/outsyde-backend/tree/fd81722f100e88b80ad342e07f9840782511a203) | 2 | 0 | 0 | 0 | 0 |
| [Ali-Razahaider/lms](https://github.com/Ali-Razahaider/lms/tree/140b62a02bbb40bd9e384d07c07c0a967d1f9e5e) | 2 | 0 | 0 | 0 | 0 |
| [BestOlumese/tyims-lms](https://github.com/BestOlumese/tyims-lms/tree/919dc48c94ed8388c9683fceb0956790395bfef6) | 2 | 0 | 0 | 0 | 0 |
| [Docaari/GrindfyManager](https://github.com/Docaari/GrindfyManager/tree/fe769faab522ad506fb8d894880ab14e7d764f43) | 4 | 1 | 0 | 0 | 0 |
| [Javaris500/allan-palmer](https://github.com/Javaris500/allan-palmer/tree/e64e877427baf8556d623361409830612124520b) | 3 | 0 | 0 | 0 | 0 |
| [Keats0206/retailtherapy](https://github.com/Keats0206/retailtherapy/tree/d43e0141bf2e972e9d646b83f5ad4aa07131b540) | 4 | 0 | 0 | 0 | 0 |
| [LetsChurch/lets.church](https://github.com/LetsChurch/lets.church/tree/3754ef409ee3d5b2a5bd992e9c2a13ae7bff52b0) | 4 | 0 | 0 | 0 | 0 |
| [Luzzotica/partii](https://github.com/Luzzotica/partii/tree/623785307400f28dffbebf7e86b6acfabe34b678) | 2 | 0 | 0 | 0 | 0 |
| [MeetMajh/v0-majh-events-ecosystem](https://github.com/MeetMajh/v0-majh-events-ecosystem/tree/d9eb8f141087956c2ff167d0d8077d5c2b01a708) | 2 | 0 | 0 | 0 | 0 |
| [Mohammad-Ali-Soomro/CourseForge](https://github.com/Mohammad-Ali-Soomro/CourseForge/tree/a913a4ac8165a4d40e156fda6bb22acfc18d8acc) | 2 | 0 | 0 | 0 | 0 |
| [Pritam-Kundu/EduSmart](https://github.com/Pritam-Kundu/EduSmart/tree/32d8b8cfcafea6297888253cc111e465633f6286) | 4 | 0 | 0 | 0 | 0 |
| [QASchoolUSA/Alla-LMS](https://github.com/QASchoolUSA/Alla-LMS/tree/4952172019a112ae9d9440364552c0d284a98e83) | 2 | 0 | 0 | 0 | 0 |
| [Schuchhardt/kefy](https://github.com/Schuchhardt/kefy/tree/22d099619fb24e3147a5e1675bdba56a7210d428) | 2 | 1 | 0 | 0 | 0 |
| [Shivanshu49/NEDC-Platform](https://github.com/Shivanshu49/NEDC-Platform/tree/b69043711352b758393348111c124d6300f5212a) | 2 | 0 | 0 | 0 | 0 |
| [XAct1HP/10kp](https://github.com/XAct1HP/10kp/tree/bce67a16786e940059ea8644a8dcf4106a631bbe) | 6 | 0 | 4 | 0 | 0 |
| [abbnelhaj/wasl_academy](https://github.com/abbnelhaj/wasl_academy/tree/18cba1e0663408a06c64d5a50df4b95764f817a0) | 2 | 0 | 0 | 0 | 0 |
| [acvigue/fitness-backend](https://github.com/acvigue/fitness-backend/tree/25de45119d1d43478d7b23c4e46ef2a2fcddee8b) | 3 | 0 | 0 | 0 | 0 |
| [anaisbetts/atmospics](https://github.com/anaisbetts/atmospics/tree/90483ded4213ec918cd24c3076b4b3a799a7eef9) | 2 | 0 | 0 | 0 | 0 |
| [brightsolutions-tn/Bright-Abodes](https://github.com/brightsolutions-tn/Bright-Abodes/tree/884568aedaa3ddf423969b11330efd45a1ebfd5a) | 2 | 0 | 0 | 0 | 0 |
| [byjasonz/sponsor-tracker](https://github.com/byjasonz/sponsor-tracker/tree/a69045af28ce6b4fe01cc90b0423d6a81aef736a) | 2 | 0 | 0 | 0 | 0 |
| [dittastudio/raw](https://github.com/dittastudio/raw/tree/bc7d0cd1534a3b051b33e2305e85153cde06bbb1) | 2 | 0 | 0 | 0 | 0 |
| [divyansh2102t-dev/VertexHub](https://github.com/divyansh2102t-dev/VertexHub/tree/2b92f7b66c367f5a56b550b7f1d2d2a6f82325cd) | 2 | 0 | 0 | 0 | 0 |
| [m3nd0zit4/dayana-pnl](https://github.com/m3nd0zit4/dayana-pnl/tree/9ced7906c61503ed0b56ddcfa2b0f2421d405490) | 3 | 0 | 0 | 0 | 0 |
| [manu-180/ponchospanish_next](https://github.com/manu-180/ponchospanish_next/tree/d816a75f4e79aa092163faee123914a14a92cf91) | 2 | 0 | 0 | 0 | 0 |
| [music-city/music-city](https://github.com/music-city/music-city/tree/3c254d8eeca2a0a65c0dc05610603ca6edba3026) | 3 | 0 | 0 | 0 | 0 |
| [nayyarsatwik30/CollabCut](https://github.com/nayyarsatwik30/CollabCut/tree/10b1c700f9a6d7274dc3488cbd6e745da4e75ced) | 2 | 0 | 0 | 0 | 0 |
| [pontusab/behindthecode](https://github.com/pontusab/behindthecode/tree/c52e5be761fb0e9efb7e7fdcef3f4a4109ebd0d4) | 2 | 0 | 0 | 0 | 0 |
| [pro-laico/payload-plugins](https://github.com/pro-laico/payload-plugins/tree/9d5f5390da335309bd357e19e2862b9c2a4488b0) | 14 | 0 | 0 | 0 | 0 |
| [reno99sonu-eng/inplayer](https://github.com/reno99sonu-eng/inplayer/tree/9b21da2ecbf3469bf28351edf46aab469fc2901a) | 2 | 0 | 0 | 0 | 0 |
| [ssquaremarketings/ssquaremarketings](https://github.com/ssquaremarketings/ssquaremarketings/tree/d76ddef5936dde3746884c2f80ec37d32c283e85) | 5 | 0 | 0 | 0 | 0 |
| [ultrabconstructions-spec/playverse-app](https://github.com/ultrabconstructions-spec/playverse-app/tree/d56d79211974b230ed568534c532511771ff97f2) | 2 | 0 | 0 | 0 | 0 |

### Type errors still present after migration, by kind

- none

### Why sites were queued

- module name @mux/mux-node appears outside import syntax: 2

## Reproducing

```sh
node bench/run.mjs --rules bench/mux-14-to-15/rules.json --repos bench/mux-14-to-15/repos.json --work ../bench-work \
  --old @mux/mux-node@14.1.1 --new @mux/mux-node@15.5.0,@mux/ts@15.5.0
node bench/report.mjs ../bench-work/results.json
node bench/coverage.mjs --calls bench/mux-14-to-15/calls-14.json --package @mux/mux-node --work ../bench-work --receiver-types
```

The rule file can be drafted again with `apimigrate draft` from two checkouts of [mux-ts](https://github.com/muxinc/mux-ts) at `v14.1.1` and `v15.0.0`. The coverage text search can count a call from another library with the same method path, and it misses a method chain split over lines and a call on a destructured resource. Every invisible site that was checked by hand was a real Mux call.

Related docs are [benchmarks](../README.md), [matching](../../docs/matching.md) and [build log](../../docs/history.md).

# Mux 14 to 15

`@mux/mux-node` 15 renamed the package to `@mux/ts`, renamed `client.robotsPreview` to `client.robots`, removed `client.data.filters`, and moved some type declarations. The full list is in Mux's [migration guide](https://github.com/muxinc/mux-ts/blob/v15.0.0/MIGRATION.md).

[rules.json](rules.json) encodes it as 16 rules: one `rename-import` to `@mux/ts`, 14 `rename-method` rules for the `robotsPreview` methods (there is no rule kind for renaming a whole namespace), and one `manual` rule for `data.filters.listValues`. Moved types cannot be expressed as rules.

The 32 repositories are every public GitHub repository that code search found pinning `@mux/mux-node` 14 in October 2026, out of 391 it found importing the package. They are listed with their commits in [repos.json](repos.json). Raw output is in [results.json](results.json) and [coverage.json](coverage.json). See [how a benchmark runs](../README.md) for the method.

## Findings

1. **No new breakage.** The rename was applied to 58 imports in 57 files with no new type errors and no gate failures.
2. **The rename breaks every build unless `package.json` changes too.** The tool rewrites imports to `@mux/ts` but cannot touch dependencies, so in all 32 repositories the migrated code fails to resolve (67 errors) until someone runs `npm uninstall @mux/mux-node && npm install @mux/ts`.
3. **Package names in plain strings were queued correctly.** Two sites a rename would otherwise break silently: `vi.mock('@mux/mux-node', ...)` in a test, and `serverExternalPackages` in a Next.js config. A third, a JSDoc `import("@mux/mux-node/...")` type in a comment, was left unchanged and not queued.
4. **Upgrading broke the type-check in 1 repository of 32, and the tool fixed none of it.** XAct1HP/10kp calls `mux.robotsPreview.jobs.*` on a client returned by `getMuxClient()` from another file. The tool neither rewrote nor queued those calls, so its output said 0 unresolved while the upgrade broke 4 lines.
5. **Most call sites are invisible to the tool.** A probe with one `manual` rule per Mux method found 156 Mux calls by text search. The tool proved 25 (16%), queued 44 (28%) and did not report 87 (56%). Among the 87, 56 get their client through a `tsconfig` path alias such as `@/lib/mux`, which the tool treats as a different package, and 44 call a factory such as `getMux()` whose return value it cannot trace (some do both). Only 5 are parameters, class fields or reassigned variables, the cases the README already lists.
6. **Many rules are slow.** The program is rebuilt once per rule. The 114-rule probe took about 0.1 s per rule on a 265-file repository, roughly 12 s for that repository and longer on monorepos.

## What to build next

In order of how many call sites each would recover in this sample:

- Resolve `tsconfig.json` `paths` and `baseUrl`, so `@/lib/mux` is followed like a relative import.
- Trace a function whose return value is provably a package instance, such as `return new Mux()` or a cached singleton.
- Report lookalike calls in files that reach the package through a local import, not only in files that import it directly, so nothing is dropped without a trace.
- A dependency step for package renames that updates `package.json` in the same pull request.
- A `rename-namespace` rule kind, so `robotsPreview.*` to `robots.*` is one rule instead of 14.
- Build the program once per run instead of once per rule.

## Results

Rule file `bench/mux-14-to-15/rules.json`, old SDK `@mux/mux-node@14.1.1`, new SDK `@mux/mux-node@15.5.0, @mux/ts@15.5.0`, run 2026-10-18.

| | |
| --- | --- |
| Repositories | 32 |
| Benchmarked | 32 (0 skipped: none) |
| Sites rewritten (imports and calls) | 58 in 57 files |
| &nbsp;&nbsp;by `package-rename` | 58 |
| Sites queued for a person or agent | 2 |
| Gate failures | 0 |
| Repos where upgrading breaks the type-check | 1 of 32 |
| Type errors caused by upgrading without migrating | 4 |
| ... fixed by apimigrate | 0 |
| ... still present after apimigrate | 4 |
| New type errors introduced by apimigrate | 0 |
| Repos whose migrated code breaks if package.json is not updated | 32 of 32 (67 errors) |
| Repos where the SDK resolved in the baseline type-check | 32 of 32 |
| Old package names left in code after migration | 3 files |
| Median apply time | 1866 ms |

### Per repository

| Repository | Rewritten | Queued | Upgrade breaks | Still broken | Added by migration |
| --- | ---: | ---: | ---: | ---: | ---: |
| [19leva89/react-ts-next-newtube](https://github.com/19leva89/react-ts-next-newtube/tree/3707c471f9d7b4765e404278d27c26773681d9d8) | 2 | 0 | 0 | 0 | 0 |
| [1outsyde/outsyde-backend](https://github.com/1outsyde/outsyde-backend/tree/fd81722f100e88b80ad342e07f9840782511a203) | 1 | 0 | 0 | 0 | 0 |
| [Ali-Razahaider/lms](https://github.com/Ali-Razahaider/lms/tree/140b62a02bbb40bd9e384d07c07c0a967d1f9e5e) | 1 | 0 | 0 | 0 | 0 |
| [BestOlumese/tyims-lms](https://github.com/BestOlumese/tyims-lms/tree/919dc48c94ed8388c9683fceb0956790395bfef6) | 1 | 0 | 0 | 0 | 0 |
| [Docaari/GrindfyManager](https://github.com/Docaari/GrindfyManager/tree/fe769faab522ad506fb8d894880ab14e7d764f43) | 3 | 1 | 0 | 0 | 0 |
| [Javaris500/allan-palmer](https://github.com/Javaris500/allan-palmer/tree/e64e877427baf8556d623361409830612124520b) | 2 | 0 | 0 | 0 | 0 |
| [Keats0206/retailtherapy](https://github.com/Keats0206/retailtherapy/tree/d43e0141bf2e972e9d646b83f5ad4aa07131b540) | 3 | 0 | 0 | 0 | 0 |
| [LetsChurch/lets.church](https://github.com/LetsChurch/lets.church/tree/3754ef409ee3d5b2a5bd992e9c2a13ae7bff52b0) | 2 | 0 | 0 | 0 | 0 |
| [Luzzotica/partii](https://github.com/Luzzotica/partii/tree/623785307400f28dffbebf7e86b6acfabe34b678) | 1 | 0 | 0 | 0 | 0 |
| [MeetMajh/v0-majh-events-ecosystem](https://github.com/MeetMajh/v0-majh-events-ecosystem/tree/d9eb8f141087956c2ff167d0d8077d5c2b01a708) | 1 | 0 | 0 | 0 | 0 |
| [Mohammad-Ali-Soomro/CourseForge](https://github.com/Mohammad-Ali-Soomro/CourseForge/tree/a913a4ac8165a4d40e156fda6bb22acfc18d8acc) | 1 | 0 | 0 | 0 | 0 |
| [Pritam-Kundu/EduSmart](https://github.com/Pritam-Kundu/EduSmart/tree/32d8b8cfcafea6297888253cc111e465633f6286) | 3 | 0 | 0 | 0 | 0 |
| [QASchoolUSA/Alla-LMS](https://github.com/QASchoolUSA/Alla-LMS/tree/4952172019a112ae9d9440364552c0d284a98e83) | 1 | 0 | 0 | 0 | 0 |
| [Schuchhardt/kefy](https://github.com/Schuchhardt/kefy/tree/22d099619fb24e3147a5e1675bdba56a7210d428) | 1 | 1 | 0 | 0 | 0 |
| [Shivanshu49/NEDC-Platform](https://github.com/Shivanshu49/NEDC-Platform/tree/b69043711352b758393348111c124d6300f5212a) | 1 | 0 | 0 | 0 | 0 |
| [XAct1HP/10kp](https://github.com/XAct1HP/10kp/tree/bce67a16786e940059ea8644a8dcf4106a631bbe) | 1 | 0 | 4 | 4 | 0 |
| [abbnelhaj/wasl_academy](https://github.com/abbnelhaj/wasl_academy/tree/18cba1e0663408a06c64d5a50df4b95764f817a0) | 1 | 0 | 0 | 0 | 0 |
| [acvigue/fitness-backend](https://github.com/acvigue/fitness-backend/tree/25de45119d1d43478d7b23c4e46ef2a2fcddee8b) | 2 | 0 | 0 | 0 | 0 |
| [anaisbetts/atmospics](https://github.com/anaisbetts/atmospics/tree/90483ded4213ec918cd24c3076b4b3a799a7eef9) | 1 | 0 | 0 | 0 | 0 |
| [brightsolutions-tn/Bright-Abodes](https://github.com/brightsolutions-tn/Bright-Abodes/tree/884568aedaa3ddf423969b11330efd45a1ebfd5a) | 1 | 0 | 0 | 0 | 0 |
| [byjasonz/sponsor-tracker](https://github.com/byjasonz/sponsor-tracker/tree/a69045af28ce6b4fe01cc90b0423d6a81aef736a) | 1 | 0 | 0 | 0 | 0 |
| [dittastudio/raw](https://github.com/dittastudio/raw/tree/bc7d0cd1534a3b051b33e2305e85153cde06bbb1) | 1 | 0 | 0 | 0 | 0 |
| [divyansh2102t-dev/VertexHub](https://github.com/divyansh2102t-dev/VertexHub/tree/2b92f7b66c367f5a56b550b7f1d2d2a6f82325cd) | 1 | 0 | 0 | 0 | 0 |
| [m3nd0zit4/dayana-pnl](https://github.com/m3nd0zit4/dayana-pnl/tree/9ced7906c61503ed0b56ddcfa2b0f2421d405490) | 2 | 0 | 0 | 0 | 0 |
| [manu-180/ponchospanish_next](https://github.com/manu-180/ponchospanish_next/tree/d816a75f4e79aa092163faee123914a14a92cf91) | 1 | 0 | 0 | 0 | 0 |
| [music-city/music-city](https://github.com/music-city/music-city/tree/3c254d8eeca2a0a65c0dc05610603ca6edba3026) | 2 | 0 | 0 | 0 | 0 |
| [nayyarsatwik30/CollabCut](https://github.com/nayyarsatwik30/CollabCut/tree/10b1c700f9a6d7274dc3488cbd6e745da4e75ced) | 1 | 0 | 0 | 0 | 0 |
| [pontusab/behindthecode](https://github.com/pontusab/behindthecode/tree/c52e5be761fb0e9efb7e7fdcef3f4a4109ebd0d4) | 1 | 0 | 0 | 0 | 0 |
| [pro-laico/payload-plugins](https://github.com/pro-laico/payload-plugins/tree/9d5f5390da335309bd357e19e2862b9c2a4488b0) | 12 | 0 | 0 | 0 | 0 |
| [reno99sonu-eng/inplayer](https://github.com/reno99sonu-eng/inplayer/tree/9b21da2ecbf3469bf28351edf46aab469fc2901a) | 1 | 0 | 0 | 0 | 0 |
| [ssquaremarketings/ssquaremarketings](https://github.com/ssquaremarketings/ssquaremarketings/tree/d76ddef5936dde3746884c2f80ec37d32c283e85) | 4 | 0 | 0 | 0 | 0 |
| [ultrabconstructions-spec/playverse-app](https://github.com/ultrabconstructions-spec/playverse-app/tree/d56d79211974b230ed568534c532511771ff97f2) | 1 | 0 | 0 | 0 | 0 |

### Type errors still present after migration, by kind

- missing property `robotsPreview`: 3
- SDK subpath no longer exists: 1

### Why sites were queued

- module name @mux/mux-node appears outside import syntax: 2

## Reproducing

```sh
node bench/run.mjs --rules bench/mux-14-to-15/rules.json --repos bench/mux-14-to-15/repos.json --work ../bench-work \
  --old @mux/mux-node@14.1.1 --new @mux/mux-node@15.5.0,@mux/ts@15.5.0
node bench/report.mjs ../bench-work/results.json
node bench/coverage.mjs --calls bench/mux-14-to-15/calls-14.json --package @mux/mux-node --work ../bench-work
```

The coverage text search can count a call from another library with the same method path. Every invisible site that was checked by hand was a real Mux call.

Related docs are [benchmarks](../README.md), [matching](../../docs/matching.md) and [build log](../../docs/history.md).

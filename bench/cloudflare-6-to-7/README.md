# Cloudflare 6 to 7

`cloudflare` 7 moved to the built-in `fetch` with no dependencies, and changed how 240 methods take their arguments: leading path parameters became keys of the params object, so `client.waitingRooms.events.get(roomId, eventId, { zone_id })` became `client.waitingRooms.events.get(eventId, { zone_id, waiting_room_id: roomId })`. It also renamed 11 methods, such as `vectorize.indexes.getByIds` to `getByIDs`. The full list is in Cloudflare's [migration guide](https://github.com/cloudflare/cloudflare-typescript/blob/v7.0.0/MIGRATION.md).

[rules.json](rules.json) holds the 254 rules that `apimigrate draft` produces from the 6.5.0 and 7.0.0 SDK checkouts, with the review marks removed: 240 `positional-to-named` rules, 11 `rename-method` rules, 2 `manual` rules for irregular changes and a `rename-dependency` to `^7.0.0`. Drafting first flagged 1,031 methods as changed, almost all because a placeholder was renamed, such as `memberId` to `memberID`. Comparing argument shapes instead left the 242 real changes.

The 12 repositories are every public GitHub repository that code search found pinning `cloudflare` 6 in October 2026, out of 419 it found importing the SDK. Most of those that pin a version are on 4 (65) or 5 (31). They are listed with their commits in [repos.json](repos.json). See [how a benchmark runs](../README.md) for the method. The run installs `@types/node` with both versions, because version 6 brought it in as a dependency and version 7 does not.

## Findings

1. **No repository in the sample breaks because of the SDK change.** None of the 12 calls any of the 240 methods whose arguments changed, or the 11 renamed ones. The one error in the table below is `Cannot find module 'form-data'` in tinkerindustries/mini-infra, a dependency that repository declares but the harness does not install. As with Mux, the breaking changes are in parts of the API that public code rarely uses. The tool updated `package.json` in all 12 and changed nothing else.
2. **The first run reported 363 errors that were not real.** Version 6 depended on `@types/node` and `form-data`, so the harness got Node's types and `form-data` for free with version 6 and not with version 7. Real projects declare those themselves. The harness now installs `--types` with both versions, and the remaining `form-data` error comes from a dependency the repository declares, which the harness does not install.
3. **The tool now proves every Cloudflare call in the sample.** A probe with one `manual` rule per method of version 6 (2,444 methods) found 41 calls.

   | Version | Proven | Queued | Invisible |
   | --- | ---: | ---: | ---: |
   | first run | 20 | 20 | 1 |
   | with parameters typed as the SDK class, untyped parameters of local helpers and class fields | 25 | 15 | 1 |
   | with methods, getters and object literal members, and callbacks a local method calls | 40 | 0 | 1 |

   The 15 calls queued before are all in tinkerindustries/mini-infra, whose client comes from a method of a local class that returns `{ cf: new Cloudflare(...), ... }`. Six read it as `const { cf } = await this.runner.getAuthorizedClient()`, through a field typed with that class. Nine get it in a callback, `this.runner.run(ctx, async ({ cf }) => cf.zones.list())`, which `run` calls with the same object. No rule in the kit changes any of the 10 methods behind mini-infra's 18 calls, so the type-check below does not exercise them. The one call counted as missed is a Google Firebase call with the same method name, `rulesets.create`, so no Cloudflare call the text search found was missed.

   `coverage.mjs --receiver-types` compares each proof with the type the full TypeScript checker gives the call's root receiver, with 7.0.0 installed. The tool proves 42 calls: the 40 above and 2 whose method chain is split over two lines, which the line-by-line text search does not count, `src/commands/share.ts:442` in DTrombett/ms-bot and `app/src/lib/auth/auth.ts:80` in tarasovcad/tobira. A call in that form that the tool did not see would not be counted as invisible either. The checker types 41 of the 42 receivers as `Cloudflare`, including all 18 in mini-infra. The other is `cf` at `scripts/setup-cf-dns.mjs:57` in riddofftechnologies-hash/riddoff-launch, an untyped parameter of the local function `getZoneId(cf)`, which the checker types as `any`. The function's only call, in `run()`, passes the module's `const cf = new Cloudflare(creds)`, so the proof is right, but the checker cannot show it.
4. **Large rule sets stay fast.** With 254 rules the median apply time is under a second.

## What to build next

- A larger sample on versions 4 and 5, where most users are.

## Results

Rule file `bench/cloudflare-6-to-7/rules.json`, old SDK `cloudflare@6.5.0`, new SDK `cloudflare@7.0.0`, also installed `@types/node@22`, run 2026-10-19.

| | |
| --- | --- |
| Repositories | 12 |
| Benchmarked | 12 (0 skipped: none) |
| Sites rewritten (imports and calls) | 12 in 12 files |
| &nbsp;&nbsp;by `dependency` | 12 |
| Sites queued for a person or agent | 0 |
| Gate failures | 0 |
| Repos where upgrading breaks the type-check | 1 of 12 |
| Type errors caused by upgrading without migrating | 1 |
| ... fixed by apimigrate | 0 |
| ... still present after apimigrate | 1 |
| New type errors introduced by apimigrate | 0 |
| package.json files updated | 12 in 12 repos |
| Repos with an SDK import its package.json does not declare | 0 of 12 (0 files) |
| Repos where the SDK resolved in the baseline type-check | 12 of 12 |
| Median apply time | 761 ms |

### Per repository

| Repository | Rewritten | Queued | Upgrade breaks | Still broken | Added by migration |
| --- | ---: | ---: | ---: | ---: | ---: |
| [DTrombett/ms-bot](https://github.com/DTrombett/ms-bot/tree/7021f884c7407089f924ff2c3cb01bd780fadc5d) | 1 | 0 | 0 | 0 | 0 |
| [alessandroste/mercury](https://github.com/alessandroste/mercury/tree/a7a10ca6be6cb84f1ed49a1ab11c431481b80c5d) | 1 | 0 | 0 | 0 | 0 |
| [as-sites/boulder.best](https://github.com/as-sites/boulder.best/tree/f25ce28ef6e8281dda151194afa98b7a8ca4a88d) | 1 | 0 | 0 | 0 | 0 |
| [axivo/website](https://github.com/axivo/website/tree/243f2b9b6526395312be0edec6f3fbd74efa6b5d) | 1 | 0 | 0 | 0 | 0 |
| [discordjs/discord-api-types](https://github.com/discordjs/discord-api-types/tree/f3ce2947a0a51a10a209e250e8cc37dbcf0b4e07) | 1 | 0 | 0 | 0 | 0 |
| [fmunteanu/floren](https://github.com/fmunteanu/floren/tree/6d7d8c07764619d04318e5200d2482ec140b618d) | 1 | 0 | 0 | 0 | 0 |
| [itsneeku/Nookies-Pings](https://github.com/itsneeku/Nookies-Pings/tree/3d4e6207799a36c8f8e3520babb830cd9e129d1b) | 1 | 0 | 0 | 0 | 0 |
| [riddofftechnologies-hash/riddoff-launch](https://github.com/riddofftechnologies-hash/riddoff-launch/tree/a8c326b1a13280c493b86330638a3b725962403e) | 1 | 0 | 0 | 0 | 0 |
| [tarasovcad/tobira](https://github.com/tarasovcad/tobira/tree/a6c604d955ca0317631599c286ff823a0bce3115) | 1 | 0 | 0 | 0 | 0 |
| [tinkerindustries/mini-infra](https://github.com/tinkerindustries/mini-infra/tree/9283e5c9f842e5da8357b81066ab8c99b9d412fc) | 1 | 0 | 1 | 1 | 0 |
| [ttoino/prism-gram](https://github.com/ttoino/prism-gram/tree/401f8e7e59404f5966ecdbc7f7283a0eed6bad3e) | 1 | 0 | 0 | 0 | 0 |
| [velolib/velolib.dev](https://github.com/velolib/velolib.dev/tree/3aeff6d8d0222828c6fbe376ec7f4774e7cc118f) | 1 | 0 | 0 | 0 | 0 |

### Type errors still present after migration, by kind

- TS2307: 1

### Why sites were queued

- none

## Reproducing

```sh
node bench/run.mjs --rules bench/cloudflare-6-to-7/rules.json --repos bench/cloudflare-6-to-7/repos.json --work ../bench-work \
  --old cloudflare@6.5.0 --new cloudflare@7.0.0 --types @types/node@22
node bench/report.mjs ../bench-work/results.json
node bench/coverage.mjs --calls bench/cloudflare-6-to-7/calls-6.json --package cloudflare --work ../bench-work --receiver-types
```

The rule file can be drafted again with `apimigrate draft` from two checkouts of [cloudflare-typescript](https://github.com/cloudflare/cloudflare-typescript) at `v6.5.0` and `v7.0.0`.

Related docs are [benchmarks](../README.md), [matching](../../docs/matching.md) and [build log](../../docs/history.md).

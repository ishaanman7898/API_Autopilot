# Cloudflare 6 to 7, argument rewrites

The [first Cloudflare benchmark](../cloudflare-6-to-7/README.md) ran the 254-rule kit on every public repository that pins `cloudflare` 6, and none of them called one of the 240 methods whose leading path parameters moved into the params object. This one runs the same rule file, [../cloudflare-6-to-7/rules.json](../cloudflare-6-to-7/rules.json), on repositories that do call them, so the `positional-to-named` rewrites run on real code.

Code search on GitHub and Sourcegraph for each of the 240 method paths, in October 2026, found 162 repositories besides the SDK's own. Each was cloned, dry-run with the 240 rules and searched for the method paths as text. Copies were counted once: a repository is left out when every affected call it makes is in a file copied from one already in the set. That left out 45 that carry opencode's console code, 6 copies of `cloudflare/mcp-server-cloudflare`, 4 of mastra, 4 of Cloudflare's worker-publisher template and 2 others. 21 more are already on version 7, 4 do not use the SDK and 9 make no affected call. The other 67 are listed with their commits and declared SDK version in [repos.json](repos.json): 8 declare version 3, 30 version 4, 21 version 5, 7 version 6 and 1 none. 63 of them were benchmarked. Apply ran out of memory on one and did not finish in 10 minutes on three (finding 7).

Every repository is type-checked against 6.5.0 as the old SDK, whatever version it declares, and errors already present with 6.5.0 are ignored as in every benchmark. Signatures before 6.5.0 were not compared, although 38 of the 67 repositories declare version 3 or 4. 6.5.0 already rejects 8 calls in 6 repositories for their arguments, to `workers.scripts.deployments.get`, `queues.consumers.get`, `workersForPlatforms.dispatch.namespaces.scripts.delete` or `kv.namespaces.values.update`, and 14 rewritten calls for their params object (finding 2). The results are from the engine (`src/`) at commit `26089fc`, unchanged since, with the benchmark scripts as committed in `5d97635` (line mapping, named timeouts and out-of-memory runs) and `00797df` (`--receiver-types`). The first run, with the engine at `04dd1ba`, is described in finding 2. The run uses `cloudflare` 7.0.0 and installs `@types/node@22` with both versions. Version 7.0.0 ships its own codemod, `npx cloudflare migrate`, for path parameter reordering, casing changes and import paths. It was not run or compared here. [calls.json](calls.json) lists the 240 methods for the coverage probe. The coverage probe (finding 5, [coverage.json](coverage.json)) and the profiling in findings 7 and 8 ran with the engine at `04dd1ba`; `26089fc` did not change `findCalls`, the `manual` rule or the resolver they use. Raw output of the rerun is in [results.json](results.json), and the first run's is in commit `fff2cde`. See [how a benchmark runs](../README.md) for the method.

## Findings

1. **The rules fix 125 of the 246 type errors the upgrade causes (51%), and introduce none.** Upgrading breaks the type-check in 58 of the 63 benchmarked repositories, and in 27 of them nothing is left after migration. 39 of the 240 `positional-to-named` rules rewrote 149 calls in 46 repositories, and each of the 125 fixed errors is inside one of those calls. None of the 11 `rename-method` rules or the 2 `manual` rules matched anything. The first run introduced 5 errors with 4 of its rewrites (finding 2). Of the 121 upgrade errors left, 67 are at calls the tool queued (finding 4), 22 come from changes no rule covers (finding 3) and 32 are modules that only the harness is missing (finding 6). Leaving out those 32, and the 7 errors at calls that 6.5.0 already rejects, all of them at queued calls, the rules fix 125 of 207 (60%). The gate passed in all 63 repositories: it looks at test files, protected CI files and added secrets, and never type-checks. The 5 repositories where the upgrade breaks nothing are ones the type-check cannot see into: 2 plain JavaScript repositories whose client the checker types as `any` (finding 5), 2 whose calls the tool does not see either (finding 5), and jmbish04/custom-cloudflare-mcp-server, where one syntax error hides every other error (finding 6).
2. **What the first run broke: 5 errors from 4 rewrites, which `26089fc` fixed.** The first run, with the engine at `04dd1ba`, rewrote 154 calls, fixed 128 upgrade errors and introduced 5 errors with 4 rewrites in 2 repositories. When the old params argument was not an object literal, that engine spread it into the new params object, `{ ${pairs}, ...${text(params)} }` (`src/transforms.js:245` at `04dd1ba`), whatever it was.
   - GriffinSego/pebble-api `database.ts:65` passes a string: `values.update(process.env.CLOUDFLARE_NAMESPACE_ID!, key, JSON.stringify(stringifiableData), { account_id: ..., metadata: "" })`. It became `update(key, { namespace_id: process.env.CLOUDFLARE_NAMESPACE_ID!, ...JSON.stringify(stringifiableData) }, { account_id: ..., metadata: "" })`, which gave TS2698, "Spread types may only be created from object types", and TS2353, because the old params object in the options slot was checked as `RequestOptions`. The call was already wrong with 6.5.0 (TS2345, a string where `ValueUpdateParams` goes), and neither version works at run time, though they fail differently: with 6.5.0 the original sends a PUT to `/accounts/undefined/...`, and with 7.0.0 the first run's rewrite threw a `CloudflareError` before sending, because `account_id` is undefined. A correct call, `update(key, { namespace_id, account_id, value: JSON.stringify(stringifiableData), metadata: "" })`, needs a person, and the tool should have queued it. The first run counted the call's upgrade error, TS2554, as fixed.
   - Groupthink-dev/cloudflare-blade-mcp `src/tools/kv.ts` types its params by position, as in `{ account_id: accountId } as Parameters<typeof client.kv.namespaces.values.get>[2]`, in `values.get`, `values.update` and `values.delete`. The first run kept the cast on the spread argument. In 7.0.0 the params type is `Parameters<...>[1]` and `[2]` is `options?: RequestOptions`, so the new object's type had no `account_id`, and all 3 calls failed with TS2345. The objects were right at run time. Without migration the same 3 calls pass their arguments in the old positions, which 7.0.0 reads differently, but tree B shows no error there because their arguments are `any` when `zod` does not resolve. rouvenschandl/cloudflare-updater `src/cloudflare.ts:246` has the same cast on `policies.update` and compiled only because `PolicyUpdateParams` requires nothing but `app_id`.

   Commit `26089fc` changed the `positional-to-named` transform ([rule format](../../docs/rule-format.md)). A params argument is merged when it is an object literal, spread when it is a name or a property read, and queued otherwise. A name is queued too when the checker types it as a primitive, or cannot type it and it is declared from a call, a template or an operator. The engine has no lib types, so a string it cannot see, such as one held in a class field, is still spread, and other spellings of the method's type, such as a type alias, are not found. The moved keys go after the last spread or computed key, so the moved values still win, and the call is queued when something before them could run code and a moved value is not a literal or a `const` or imported name. A params argument with a type assertion keeps it and is spread, `Parameters<typeof <call>>[N]` in the call's arguments is shifted to the new positions, and `Parameters<typeof <call>>` elsewhere in the file is queued. Comments before or between the arguments queue the call instead of being lost. The rerun introduces no type errors. The 3 Groupthink-dev calls and rouvenschandl's are rewritten with the index shifted, as in `{ ...({ account_id: accountId } as Parameters<typeof client.kv.namespaces.values.get>[1]), namespace_id: params.namespace_id }`, and have no type error. pebble-api's call is queued, and so are 4 calls the first run rewrote without a type error, 1 for a comment and 3 for the new order rule (finding 4). The rerun fixes 125 upgrade errors, 3 fewer than the first run: pebble-api's TS2554, which was not a real fix, and the errors in the calls at Helicone/helicone `cloudflareKV.ts:35` (recorded at `:37`) and Lakphy/quote0-api-demo `route.ts:389`, whose calls are now queued.

   The 149 rewrites of the rerun are correct when read against the 7.0.0 declarations: the moved value becomes a key under its 7.0.0 name, which is a required key of the params type for each of the 39 rules, and the other arguments are kept. A script that parses each original and rewritten call found no exception: the moved keys come first, or after the last spread in 23 rewrites, and the old params object's properties are kept in order, or the old argument is spread, in 14, with its `Parameters<...>[N]` index shifted in 4. 7 of the 149 have an `any` receiver or params object, so only reading shows they are right. A check of each rewritten call with each SDK, outside the benchmark, using the repository's benchmark config with the rewritten file added and reading that file's own diagnostics, found that 142 of the 149 original calls fail with 7.0.0. After migration 128 of those have no error in the call, 3 only because the new params object is `any`: hefy2027/cf-manager `rulesetService.ts:79` and `:95` and spacelift-flows-apps/flows-app-cloudflare `updateRateLimitingRule.ts:236`, and 14 keep only the error they already had with 6.5.0, such as `body` on `DomainEditParams`. The other 7 have no error before or after migration. The rule also treats the third argument as params for the 6 methods that had a second `(a, b, options?)` overload in 6.5.0, such as `rulesets.rules.delete`, so request options passed there would be merged into params. The rule for `tenantCustomNameservers.delete` always would, because its 6.5.0 form `delete(tenantTag, customNSId, options?)` takes no params. The 6 calls to such methods in this run all pass params, and none calls `tenantCustomNameservers.delete`.

   The benchmark type-checks with `strict` off (`bench/run.mjs:67`), which hid one more fault in the first run. Where the old params argument was a variable whose 7.0.0 type already requires the moved key, the first run put the moved key before the spread, as in `{ namespace_id: namespaceId, ...params }`, and with `strict` on TypeScript reports TS2783, "'namespace_id' is specified more than once". A check with `strict` of the 17 files that hold the rerun's 23 rewrites with a spread, each file checked with only the SDK resolved, finds 5 such rewrites in the first run's output, in EthanThatOneKid/sparql-agent (3), Infrawrench/Infrawrench (1) and ThunLights/Status-Guard (1), all three of which build with `strict`, and none in the rerun's, which writes `{ ...params, namespace_id: namespaceId }`.
3. **What no rule covers: 22 errors.**
   - 9 imports from paths that 7.0.0 no longer exports: `cloudflare/core` (4, such as `import type { RequestOptions } from "cloudflare/core"`), `cloudflare/core.mjs` (2) and `cloudflare/src/resources/...` (3). The 7.0.0 changelog lists both changes.
   - 9 in Infrawrench/Infrawrench from the client's generic `get` and `put`, which took two type arguments in 6.5.0, `get<Req, Rsp>(path, opts?)`, and take one in 7.0.0, `get<Rsp>(path, opts?)`: 6 TS2558 and 3 that follow from the first type argument now being read as the response type.
   - 2 in user code that names a params type which now requires the moved path parameter: `const body: PolicyUpdateParams & PolicyRules = { account_id, ... }` without `app_id` in Infrawrench, and a wrapper in ThunLights/Status-Guard whose own parameter is typed `RuleEditParams`, which now requires `ruleset_id`. The SDK calls inside both are rewritten to the right shape, with the moved key after the spread (finding 2).
   - 1 `page.nextPageParams()` in bearBoy80/cflareOps. 6.5.0 marked it deprecated, and 7.0.0 has `nextPageRequestOptions()` instead.
   - 1 `client.zones.list({ query })` in cloudflare/mcp-server-cloudflare, which relied on a `list(options)` overload that 7.0.0 removed.
4. **The tool queued 72 calls in 24 repositories, 47 of them for reasons it could remove.** The queued calls hold 67 of the 121 upgrade errors left.
   - 33 because the receiver could not be traced to `cloudflare`. The full TypeScript checker types 31 of these receivers as `Cloudflare`. `src/bindings.js` does not follow a type alias, `type CloudflareClient = Cloudflare` (9 calls), or the property type of an interface, intersection or inline object type, such as `ctx.cloudflare` with `interface ProviderContext { readonly cloudflare: Cloudflare }` (22 calls, 8 of which also need the type an untyped parameter gets from its context). 14 are in mizchi/k1c. The other 2, in jpheimonen/flaregun, are rightly queued: one receiver is cast to a local interface and the other is a test mock.
   - 29 because moving the arguments could change the order of side effects. 14 of these are only `this.x` reads, which `isSimple` (`src/transforms.js:202`) rejects although it accepts `obj.x`, and 1 is `process.env.CLOUDFLARE_KV_NAMESPACE_ID ?? ""`. 11 move a function call, such as `encodeR2ObjectKey(key)`. From reading their source the helpers are pure, and in 9 of the 11 every other moved or kept argument is a literal, a constant or a parameter, but the tool does not check either. The other 3 are new in the rerun and come from the order rule of `26089fc`: the moved keys now go after the last spread, so a call in the params object would run before the moved value is read, and only a literal or a `const` or imported name may be read late. Like the 11 helper calls, they are not counted among the calls the engine could clearly stop queuing, since that means knowing what a called function does. In Lakphy/quote0-api-demo `src/app/dot/api/devices/route.ts:278` and `:389` the params object is `{ value: JSON.stringify(normalizedDevice), ...params }` and the moved value `CLOUDFLARE_CONFIG.namespaceId`. In gwelinder/pi-cloudflare-codemode `templates/cloudflare-codemode-worker/src/index.ts:1080` they are `{ ...scope.params, ...buildAccessPolicyPayload(args) } as any` and `args.appId`. From reading the code, neither call changes the value read.
   - 6 because the call does not pass the 2 positional arguments the rule expects. Queuing is right, since 6.5.0 already rejects all 6 with TS2554. 5 use a list-style form, `workers.scripts.deployments.get(scriptName, { account_id })` or `queues.consumers.get(queueId, { account_id })`, that needs a call to `list()` instead, and 1 passes a single object to `workersForPlatforms.dispatch.namespaces.scripts.delete`.
   - 2 because the arguments come from a spread, `get(...args)` in SkyBird233/cf-pages-logs, where the shared tuple has to change instead. Queuing is right.
   - 1 because the params argument is not an object literal, a name or a property read: pebble-api's `JSON.stringify(stringifiableData)` from finding 2. Queuing is right.
   - 1 because comments around the arguments would be lost: Helicone/helicone `valhalla/jawn/src/lib/clients/cloudflareKV.ts:35`, whose `// value,` line between the arguments the first run dropped. Carrying the comment into the rewrite would remove the queue.

   The 47 are the 31 receivers typed as `Cloudflare`, the 15 `this.x` and `??` calls and the comment. A script that copies the rule's syntactic argument checks at `26089fc`, with the checks that need the checker's types judged by reading, says 45 of the 47 would be rewritten once the receiver is traced, the arguments accepted or the comment carried over. The other 2 are in mizchi/k1c: `deployments.get(nativeId, { ... })` has the list-style form above, and `scripts.update` in `src/canary/effects-cloudflare.ts:108` would be queued by the order rule, because its params object, cast `as never`, calls `buildMetadata(...)` and the moved value is a parameter. jpheimonen/flaregun `src/sync/access.ts:240` carries a `Parameters<typeof ...>[2]` cast, which `26089fc` would shift to `[1]`. None of this was checked by a run.
5. **The tool proves 80% of the Cloudflare calls the text search finds, and misses 14.** A probe with one `manual` rule per method in calls.json found 233 calls by text search in the 63 benchmarked repositories. It ran with the engine at `04dd1ba`. `26089fc` did not change the matching it uses, `findCalls` and the `manual` rule.

   | | Proven | Queued | Invisible |
   | --- | ---: | ---: | ---: |
   | Cloudflare calls | 187 (80%) | 31 (13%) | 15 (6%) |

   A `manual` rule only needs a traced receiver, so the 39 calls that apply queues for their arguments count as proven here. The probe's 31 queued are apply's 33 receiver queues less 2 in caiomioto2/meta-ads-saas whose method chain is split over two lines, which the line-by-line text search does not count. One of the 15 invisible is a JSDoc comment in mfinelli/cloudflare-pages-cleanup, whose real call is rewritten. The other 14 are real calls the tool neither rewrites nor queues:
   - 10 in christcr2012/robinsonai-mcp-servers-49bf1a39 call `this.cloudflareClient` inside exported functions typed `this: any`, in files that import nothing. No file in the repository assigns `this.cloudflareClient` or imports these functions.
   - 3 in cloudflare/mcp-server-cloudflare and 1 in dociodev/docio get the client from a workspace package imported by name, `@repo/mcp-common/src/cloudflare-api` (a pnpm workspace) and `@docio/cloudflare` (a Deno workspace). The engine maps bare imports to scanned files only through `paths` and `baseUrl` in `tsconfig.json` or `jsconfig.json`, and `src/match.js:145` drops a lookalike call whose receiver comes from another module without queuing it.

   The type-check cannot count these misses either, because tsc types all 14 receivers as `any`. The 4 repositories that were not benchmarked hold 9 more text hits, which the totals leave out (finding 7).

   `coverage.mjs --receiver-types` typed the root receiver of 188 proven calls, the 187 above and one in The-LukeZ/DiscordDataViewer split over two lines: 184 are `Cloudflare`, and 4 are `any`, all in plain JavaScript, from `new` on `require("cloudflare")` in DeveloperKubilay/Karshard and from a `let cloudflareClient = null` assigned in an `if` in alecks/digifilm. Reading the code shows those 4 proofs are right, but the benchmark's type-check cannot see their rewrites either.
6. **The harness counts 39 errors the upgrade did not cause, and misses 17 rewritten calls the upgrade breaks.**
   - 32 are TS2307 for `node-fetch` (18), `ms` (10), `form-data` (3) and `mime-types` (1), modules that 6 repositories declare. Tree A resolves them only through the dependencies of `cloudflare` 6.5.0, and 7.0.0 has none. They are 17 of JesusFilm/core's 19 errors left and 10 of orctane/opentools's 13.
   - 7 are at calls that 6.5.0 already rejects, all queued. 6 have TS2554 with 6.5.0: 5 of the 6 calls queued for their argument count in finding 4, and mizchi/k1c `src/providers/worker-deployment.ts:68`, queued for its receiver. 7.0.0 gives TS2345 instead, sometimes on another line, so file, line and code no longer match. The sixth argument-count call, in shopify-magical/agx9-staff, has the same TS2554 with both SDKs, so it is not counted. The seventh is pebble-api `database.ts:65`, which 6.5.0 rejects with TS2345 and 7.0.0 with TS2554, and which the first run counted as fixed (finding 2).
   - 17 rewritten calls fail with 7.0.0 before migration and are not counted. jmbish04/custom-cloudflare-mcp-server has a syntax error at `src/cloudflare-worker.ts:553`, and tsc then reports no other errors for the repository (6 calls). Two files of hefy2027/cf-manager do not name the package, so they are not type-checked (9 calls). In Groupthink-dev/cloudflare-blade-mcp and Tanvisharma31/cloudflare-mcp-server, an upgrade error has the same file, line and code as a different baseline error (2 calls). Checked the same way, all 17 fail with 7.0.0 before migration and lose that error after the rewrite. The 2 `deployments.rollback` calls in Groupthink-dev and Tanvisharma31 keep the `body` error they already had with 6.5.0, 2 of the 14 in finding 2, and in 2, hefy2027/cf-manager `rulesetService.ts:79` and `:95`, the new params object is `any`.
7. **4 of the 67 repositories could not be benchmarked.**
   - Apply did not finish in 10 minutes on vaishnav-mk/workflows-plus-plus, sureboy/jscadwebsite and streetwriters/notesnook. Each contains minified files, such as three 1 MB copies of `agents.mcp.bundle.mjs` in vaishnav-mk and `apps/web/public/pdf.worker.min.js` in notesnook. The resolver is quadratic on them. `findCalls` (`src/match.js:139-141`) resolves the callee of every call in every file, including files that never import the SDK, and for each `let` or `var` (`fromMutable`, `src/bindings.js:212-230`) or untyped parameter of a local function (`fromParameter`, `src/bindings.js:526-556`) that it follows, it walks the whole file and asks the checker for the symbol of every identifier. In one bundle with 104,769 identifiers, 94 callees made 11.1 million lookups in 15 s. With the files that have a line over 10,000 characters removed, a dry-run with the kit at `04dd1ba` finishes in 1.07 s on vaishnav-mk and 23 s on sureboy/jscadwebsite, and the coverage probe finishes in 53 s on notesnook, where the kit was not run.
   - Apply ran out of memory on mastra-ai/mastra after 18 s. The engine parses all 16,267 code files into one TypeScript program, and the heap reached Node's 4.4 GB limit while building it, before any rule ran. The coverage probe reports the same abort as "apply crashed (SIGABRT)".
   - These 4 repositories hold 9 of the probe's 242 text hits, all real Cloudflare calls. With the minified files removed, and with mastra's `stores/cloudflare` package (29 code files) scanned alone, the tool proves 7 and queues 2.
8. **Apply is slow on some large repositories and on bundled files.** The median apply time is 571 ms, but 6 repositories took over 10 s: Infrawrench/Infrawrench 181 s, julienloizelet/cs-cloudflare-bouncer-gui 110 s, anomalyco/opencode 81 s, opraying/template 31 s, JesusFilm/core 22 s and Helicone/helicone 11 s. In Infrawrench, where 8 rules changed 13 sites, 9 calls and 4 `package.json` files, the program and resolver are rebuilt after each rule that edits a file (`src/engine.js:34-42`), which repeats the work; this was not profiled. julienloizelet/cs-cloudflare-bouncer-gui has only 32 code files, and only the dependency rule, the last of the 254, changed anything there, so nothing was rebuilt. Its time goes to two webpack bundles under `src/server/assets/workers/` (7,354 and 6,564 lines, longest line 759 characters): without them a dry-run at `04dd1ba` takes 0.3 s with the same result. JesusFilm/core also rebuilt nothing, and its time was not profiled. At commit `ace4b34`, before `48dd84a` indexed global-object writes and identifiers once per resolver, the coverage probe timed out on Infrawrench, JesusFilm/core and anomalyco/opencode.
9. **The dependency rule updated 84 `package.json` files in 60 repositories, and no Deno import map.** It writes `^7.0.0` over 16 exact pins and 4 `~6.4.0` ranges in 7 repositories, the same loosening the [Orb benchmark](../orb-5-to-6/README.md) found. EthanThatOneKid/sparql-agent and dociodev/docio declare the SDK only in `deno.json`, as `npm:cloudflare@^5.2.0` and `npm:cloudflare@^4.1.0`, which the rule does not edit. jmbish04/custom-cloudflare-mcp-server does not declare it at all. The 22 files in 9 repositories that import the SDK without their nearest `package.json` declaring it, in the results below, were undeclared before migration too. The dependency rule only changes versions already declared.
10. **Evidence lines drift when two rules edit one file.** Evidence records each site at its line in the file as earlier rules left it (`src/engine.js:57` for rewritten sites, `:60` for queued ones), so 19 of the 149 rewrite lines are not the call's line in the original file. `values.delete` in Groupthink-dev's `src/tools/kv.ts` is recorded at 430, is at 432 in the original and at 428 after migration. Queued sites drift the same way: shopify-magical/agx9-staff `scripts/deploy-platform.ts` records a queued call at 52 that is at 54 in the original. The first run recorded Helicone/helicone's queued `values.delete` at `cloudflareKV.ts:123`, and the rerun at 126, its line in the original, because the rerun no longer rewrites the call above it.

## What to build next

- Type-check the changed files in the gate, so a rewrite that adds a type error fails it.
- Follow type aliases and the property types of interfaces, intersections and inline object types, or take the checker's receiver type as proof (31 queued calls).
- Treat `this.x` and `a ?? b` of simple operands as free of side effects (15 queued calls).
- Tell whether a call among the moved or kept arguments, or in the params object before the moved keys, can change a moved value, such as `encodeR2ObjectKey(key)` or `JSON.stringify(...)` (14 queued calls).
- Check identifier names before asking the checker in `fromMutable` and `fromParameter`, cache their answers per symbol, and skip or bound generated bundles, which need not have long lines (3 timeouts, and julienloizelet's 110 s). Build smaller programs for large monorepos (1 out of memory).
- Resolve workspace packages by name, and queue lookalike calls whose receiver comes from an unresolved import (4 invisible calls).
- Kit: rules or prompts for the removed `cloudflare/core` and `cloudflare/src` paths, the client's `get` and `put` type arguments, `nextPageParams()` and `zones.list(options)`.
- Carry comments between arguments into the rewrite instead of queuing the call (1 queued call), record evidence lines in original-file coordinates, keep exact pins exact and update `deno.json` import maps.
- Run `npx cloudflare migrate` on the same repositories and compare.
- Harness: install the old SDK's dependencies with the new one, type-check with each repository's own `strict` setting, type-check each file on its own so one syntax error does not hide a repository, check every rewritten file, and compare errors by call so a changed code at a call already broken does not count as an upgrade break. Make `coverage.mjs` name out-of-memory aborts, skip comments and match method chains split over lines.

## Results

Rule file `bench/cloudflare-6-to-7/rules.json`, old SDK `cloudflare@6.5.0`, new SDK `cloudflare@7.0.0`, also installed `@types/node@22`, run 2026-10-19.

| | |
| --- | --- |
| Repositories | 67 |
| Benchmarked | 63 (4 skipped: 1 apply ran out of memory, 3 apply did not finish in 10 minutes) |
| Sites rewritten (imports and calls) | 234 in 157 files |
| &nbsp;&nbsp;by `dependency` | 85 |
| &nbsp;&nbsp;by `named-stream.captions.language.vtt.get` | 1 |
| &nbsp;&nbsp;by `named-stream.captions.language.delete` | 1 |
| &nbsp;&nbsp;by `named-rulesets.rules.edit` | 8 |
| &nbsp;&nbsp;by `named-kv.namespaces.values.get` | 30 |
| &nbsp;&nbsp;by `named-kv.namespaces.values.update` | 22 |
| &nbsp;&nbsp;by `named-kv.namespaces.values.delete` | 15 |
| &nbsp;&nbsp;by `named-pages.projects.domains.edit` | 2 |
| &nbsp;&nbsp;by `named-pages.projects.deployments.get` | 2 |
| &nbsp;&nbsp;by `named-pages.projects.deployments.rollback` | 3 |
| &nbsp;&nbsp;by `named-workers.scripts.secrets.delete` | 4 |
| &nbsp;&nbsp;by `named-zeroTrust.access.applications.policies.get` | 2 |
| &nbsp;&nbsp;by `named-zeroTrust.access.applications.policies.update` | 2 |
| &nbsp;&nbsp;by `named-rulesets.rules.delete` | 3 |
| &nbsp;&nbsp;by `named-secretsStore.stores.secrets.edit` | 1 |
| &nbsp;&nbsp;by `named-secretsStore.stores.secrets.delete` | 1 |
| &nbsp;&nbsp;by `named-workflows.instances.status.edit` | 2 |
| &nbsp;&nbsp;by `named-workersForPlatforms.dispatch.namespaces.scripts.assetUpload.create` | 2 |
| &nbsp;&nbsp;by `named-workersForPlatforms.dispatch.namespaces.scripts.update` | 17 |
| &nbsp;&nbsp;by `named-workersForPlatforms.dispatch.namespaces.scripts.delete` | 5 |
| &nbsp;&nbsp;by `named-queues.consumers.delete` | 1 |
| &nbsp;&nbsp;by `named-pages.projects.deployments.history.logs.get` | 1 |
| &nbsp;&nbsp;by `named-pages.projects.deployments.retry` | 1 |
| &nbsp;&nbsp;by `named-pages.projects.domains.delete` | 2 |
| &nbsp;&nbsp;by `named-r2.buckets.domains.custom.delete` | 1 |
| &nbsp;&nbsp;by `named-workersForPlatforms.dispatch.namespaces.scripts.get` | 1 |
| &nbsp;&nbsp;by `named-pages.projects.deployments.delete` | 4 |
| &nbsp;&nbsp;by `named-aiGateway.logs.get` | 1 |
| &nbsp;&nbsp;by `named-zeroTrust.access.applications.policies.delete` | 1 |
| &nbsp;&nbsp;by `named-workflows.instances.get` | 2 |
| &nbsp;&nbsp;by `named-workers.scripts.secrets.get` | 1 |
| &nbsp;&nbsp;by `named-waitingRooms.events.get` | 1 |
| &nbsp;&nbsp;by `named-waitingRooms.events.delete` | 1 |
| &nbsp;&nbsp;by `named-kv.namespaces.metadata.get` | 2 |
| &nbsp;&nbsp;by `named-r2.buckets.objects.get` | 1 |
| &nbsp;&nbsp;by `named-r2.buckets.objects.upload` | 1 |
| &nbsp;&nbsp;by `named-r2.buckets.objects.delete` | 1 |
| &nbsp;&nbsp;by `named-workers.scripts.versions.get` | 1 |
| &nbsp;&nbsp;by `named-workersForPlatforms.dispatch.namespaces.scripts.secrets.update` | 1 |
| &nbsp;&nbsp;by `named-workers.beta.workers.versions.delete` | 1 |
| Sites queued for a person or agent | 72 |
| Gate failures | 0 |
| Repos where upgrading breaks the type-check | 58 of 63 |
| Type errors caused by upgrading without migrating | 246 |
| ... fixed by apimigrate | 125 |
| ... still present after apimigrate | 121 |
| New type errors introduced by apimigrate | 0 |
| package.json files updated | 84 in 60 repos |
| Repos with an SDK import its package.json does not declare | 9 of 63 (22 files) |
| Repos where the SDK resolved in the baseline type-check | 63 of 63 |
| Median apply time | 571 ms |

### Per repository

| Repository | Rewritten | Queued | Upgrade breaks | Still broken | Added by migration |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Christopher-Hayes/yt-on-fedi](https://github.com/Christopher-Hayes/yt-on-fedi/tree/9ac52536f138b111d27f26ddd32647eb682176c0) | 3 | 0 | 2 | 0 | 0 |
| [DeveloperKubilay/Karshard](https://github.com/DeveloperKubilay/Karshard/tree/f54f6b0bef9204e36e905eb586937e3fc34f3962) | 2 | 0 | 0 | 0 | 0 |
| [EthanThatOneKid/sparql-agent](https://github.com/EthanThatOneKid/sparql-agent/tree/ef855f9d3c0192bdc5668c599cd5004406eb0791) | 3 | 0 | 4 | 1 | 0 |
| [ExaDev/InfraSync](https://github.com/ExaDev/InfraSync/tree/9bfa1a634053100d6a8e1da1563e00bfbc91ad68) | 4 | 1 | 2 | 1 | 0 |
| [GriffinSego/pebble-api](https://github.com/GriffinSego/pebble-api/tree/03003c2beb20b1d0c6978d8bfbdc446746ac6daf) | 2 | 1 | 2 | 1 | 0 |
| [Groupthink-dev/cloudflare-blade-mcp](https://github.com/Groupthink-dev/cloudflare-blade-mcp/tree/6bae375af073dc8ff61c15127afcbfae8e90e89a) | 7 | 2 | 4 | 2 | 0 |
| [Helicone/helicone](https://github.com/Helicone/helicone/tree/067d9290acb4f1fc9320e902fc67b4b399b50363) | 2 | 2 | 3 | 2 | 0 |
| [Infrawrench/Infrawrench](https://github.com/Infrawrench/Infrawrench/tree/90e4b2a83297edfe10097bcabf42d0787ecf980e) | 13 | 3 | 22 | 13 | 0 |
| [JesusFilm/core](https://github.com/JesusFilm/core/tree/c636c318e8d37a905ee1221becf596845c92bbc1) | 1 | 1 | 19 | 19 | 0 |
| [Lakphy/quote0-api-demo](https://github.com/Lakphy/quote0-api-demo/tree/f8fab785f5167a31629204ea993024b6ae5ea113) | 12 | 2 | 12 | 1 | 0 |
| [MyGameOne/nintendo-switch-scraper](https://github.com/MyGameOne/nintendo-switch-scraper/tree/fbffb41bc45c5830ee7e58334ce6ed6231f5b2bc) | 1 | 6 | 6 | 6 | 0 |
| [SkyBird233/cf-pages-logs](https://github.com/SkyBird233/cf-pages-logs/tree/0928eaa3be549f31347384cfa14bd7ef08eab5a8) | 1 | 2 | 2 | 2 | 0 |
| [Tanvisharma31/cloudflare-mcp-server](https://github.com/Tanvisharma31/cloudflare-mcp-server/tree/9a18f3bcc4144d3bf686d00080f0774737ec812a) | 6 | 0 | 4 | 0 | 0 |
| [The-LukeZ/DiscordDataViewer](https://github.com/The-LukeZ/DiscordDataViewer/tree/56811c90f3c279ac104e2a335f24c275236320b6) | 4 | 0 | 3 | 0 | 0 |
| [ThunLights/Status-Guard](https://github.com/ThunLights/Status-Guard/tree/a73ea37470cfe7e7ea30e1828df633ad46696537) | 2 | 0 | 4 | 3 | 0 |
| [TimoWilhelm/wfp-manager](https://github.com/TimoWilhelm/wfp-manager/tree/827ee19e7d04accc4791cd15b3f44baf879c5cf5) | 3 | 0 | 2 | 0 | 0 |
| [abdu6666/Bunny-AI-Agent](https://github.com/abdu6666/Bunny-AI-Agent/tree/dd94e4aba18769897604de744d17cbd62a7038d5) | 3 | 0 | 2 | 0 | 0 |
| [aizen2006/MarketSage](https://github.com/aizen2006/MarketSage/tree/40869a1184dfcb2e73ffce07dfe32b73881d81a1) | 4 | 0 | 3 | 0 | 0 |
| [alchemy-run/alchemy-async](https://github.com/alchemy-run/alchemy-async/tree/ae168f2e206fc14e1f37fef3925ce2644bbf5014) | 8 | 0 | 1 | 0 | 0 |
| [alecks/digifilm](https://github.com/alecks/digifilm/tree/399b10c4c04e6c11cc34a3ac53efa8a33f08515d) | 4 | 0 | 0 | 0 | 0 |
| [alhill/newportfolionog](https://github.com/alhill/newportfolionog/tree/4fd69821a0d27560dd7b19b9a1f026523f7aa07d) | 1 | 3 | 3 | 3 | 0 |
| [anomalyco/opencode](https://github.com/anomalyco/opencode/tree/18f4363d2f3ac63f35b7bffc497130ecf715fbc7) | 3 | 0 | 3 | 1 | 0 |
| [apandey16/news_ainchor](https://github.com/apandey16/news_ainchor/tree/b4a99c2ab2350f5889a4d16fc02cab5b59ba6e59) | 3 | 0 | 3 | 1 | 0 |
| [axtuki1/kick-ban-chance](https://github.com/axtuki1/kick-ban-chance/tree/8abbe2b5a9aa22853d7747103d9f9bd68a2f2b93) | 3 | 0 | 2 | 0 | 0 |
| [bearBoy80/cflareOps](https://github.com/bearBoy80/cflareOps/tree/f25c3f3a433b4b89dd3fcc7f835fb02538def3b2) | 8 | 4 | 12 | 5 | 0 |
| [caiomioto2/meta-ads-saas](https://github.com/caiomioto2/meta-ads-saas/tree/c2b0a6c2516752ef3410cd31ac7400d8f1169759) | 2 | 6 | 6 | 6 | 0 |
| [christcr2012/robinsonai-mcp-servers-49bf1a39](https://github.com/christcr2012/robinsonai-mcp-servers-49bf1a39/tree/b61797ca442a6275bc3c3647247adee04a4609e6) | 2 | 0 | 0 | 0 | 0 |
| [cloudflare/mcp-server-cloudflare](https://github.com/cloudflare/mcp-server-cloudflare/tree/e4cf085520ea7286af77abf938d645c610ef1580) | 6 | 0 | 4 | 4 | 0 |
| [cloudflare/templates](https://github.com/cloudflare/templates/tree/dfdf14099a81a08cfe1ffc78f8463605670ae513) | 3 | 0 | 3 | 1 | 0 |
| [cloudflare/workers-for-platforms-example](https://github.com/cloudflare/workers-for-platforms-example/tree/ef610f818cf8674299139997deb403a052a8f36a) | 2 | 0 | 1 | 0 | 0 |
| [codius/codius-workers](https://github.com/codius/codius-workers/tree/9814eda06aa6f57cd30c1c327dc309d5666eca23) | 4 | 0 | 2 | 0 | 0 |
| [crowdsecurity/cs-cloudflare-worker-bouncer-install](https://github.com/crowdsecurity/cs-cloudflare-worker-bouncer-install/tree/0196067f00c88ae5c10a0c613278142c2c8b471d) | 1 | 6 | 6 | 6 | 0 |
| [dociodev/docio](https://github.com/dociodev/docio/tree/191fb91e690871711c0624a5c8bc5cb809c2912c) | 0 | 0 | 0 | 0 | 0 |
| [erfianugrah/cloudflare_api_scripts](https://github.com/erfianugrah/cloudflare_api_scripts/tree/859d9ed9f638b239d9dfee6662eecbdf6c77458e) | 1 | 2 | 2 | 2 | 0 |
| [fanonwue/cf-deployment-deleter](https://github.com/fanonwue/cf-deployment-deleter/tree/17246dbbb1e2a7cc1efc92426f8c4ea9592ce334) | 2 | 0 | 2 | 1 | 0 |
| [fiberplane/fiberplane](https://github.com/fiberplane/fiberplane/tree/22dc552110d2a424bbced4d3cce9c3bf2139d7d5) | 2 | 0 | 1 | 0 | 0 |
| [gwelinder/pi-cloudflare-codemode](https://github.com/gwelinder/pi-cloudflare-codemode/tree/b45f1b80bb3ea5581e3a69d713873b9b793f9843) | 11 | 1 | 10 | 0 | 0 |
| [hefy2027/cf-manager](https://github.com/hefy2027/cf-manager/tree/9164efcb6c8953475227edc6b2e002d8c1d41011) | 14 | 0 | 5 | 1 | 0 |
| [hyperholmes/orgflare](https://github.com/hyperholmes/orgflare/tree/330b8dc3f0efb95e885210a3115f551d2903501c) | 9 | 0 | 8 | 2 | 0 |
| [jmbish04/custom-cloudflare-mcp-server](https://github.com/jmbish04/custom-cloudflare-mcp-server/tree/6d4a4ab446f7d3b26edd802e04cfdb5245da586c) | 6 | 0 | 0 | 0 | 0 |
| [jpheimonen/flaregun](https://github.com/jpheimonen/flaregun/tree/19f70ae799ac674984d30dab0ec06c67554b50f7) | 1 | 3 | 1 | 1 | 0 |
| [julienloizelet/cs-cloudflare-bouncer-gui](https://github.com/julienloizelet/cs-cloudflare-bouncer-gui/tree/55fa9a76cf5215a877aea3d0da8a576688b1b849) | 1 | 2 | 2 | 2 | 0 |
| [jwyGithub/cloudflare-workers](https://github.com/jwyGithub/cloudflare-workers/tree/731180cde5f71ae26e28794c17e53421f7bdcef4) | 3 | 0 | 2 | 0 | 0 |
| [lemonmade/watch](https://github.com/lemonmade/watch/tree/2eee4e6c08735bf831272f942541e04ad3b48a74) | 2 | 0 | 1 | 0 | 0 |
| [m1steranderson/interview](https://github.com/m1steranderson/interview/tree/d6f81fab4515384f55bcefc9d134669b067ead1b) | 1 | 3 | 3 | 3 | 0 |
| [markjmiller/workers-hmd](https://github.com/markjmiller/workers-hmd/tree/14030d8656211a83eb9c3f1ea24577ab8860d272) | 1 | 1 | 1 | 1 | 0 |
| [mastermakrela/cf-cleanup-worker](https://github.com/mastermakrela/cf-cleanup-worker/tree/286bebb790ed72903b1060e346de74f03d550496) | 2 | 0 | 1 | 0 | 0 |
| [mastra-ai/mastra](https://github.com/mastra-ai/mastra) | apply ran out of memory | | | | |
| [mfinelli/cloudflare-pages-cleanup](https://github.com/mfinelli/cloudflare-pages-cleanup/tree/35a138c6dfb1479313c0e3f21a5a6ecaa54dff31) | 2 | 0 | 1 | 0 | 0 |
| [mizchi/k1c](https://github.com/mizchi/k1c/tree/80e2568696a4b655b74296f2699e5ce25b17c90c) | 3 | 14 | 16 | 14 | 0 |
| [myselfgus/worker-publisher](https://github.com/myselfgus/worker-publisher/tree/8ef127bc73c2d7bc03361b3b95102b1230de8a74) | 6 | 0 | 5 | 0 | 0 |
| [nandanmen/wakaran-ai](https://github.com/nandanmen/wakaran-ai/tree/0e1d6fbf0a68c3eb3bc76edfed127557866b722c) | 3 | 0 | 2 | 0 | 0 |
| [opennextjs/opennextjs-cloudflare](https://github.com/opennextjs/opennextjs-cloudflare/tree/15f4c9e5c1c5080eb87d0634be636aeede23febd) | 1 | 1 | 1 | 1 | 0 |
| [opraying/template](https://github.com/opraying/template/tree/204a2264bedd945712c198ae3e5592fda5dc076f) | 2 | 0 | 1 | 0 | 0 |
| [orctane/opentools](https://github.com/orctane/opentools/tree/a10cd18b88e5ed575cd0494644e1551fc9816399) | 1 | 3 | 13 | 13 | 0 |
| [rouvenschandl/cloudflare-updater](https://github.com/rouvenschandl/cloudflare-updater/tree/65796e78514da78ff3c177436c65c4902f8ed5cb) | 2 | 0 | 1 | 0 | 0 |
| [ryanyogan/cloudflare-tui-ink](https://github.com/ryanyogan/cloudflare-tui-ink/tree/2c7a0ee723a5c3101e4d8c5a0c684dfcb18144f7) | 1 | 2 | 2 | 2 | 0 |
| [shopify-magical/agx9-staff](https://github.com/shopify-magical/agx9-staff/tree/3a033d8c432bbda021a09e3ddf80c6731de3ec89) | 2 | 1 | 1 | 0 | 0 |
| [shun-yamazaki/v-metrics](https://github.com/shun-yamazaki/v-metrics/tree/5b970082dffa96f7f312444d50ebfb46d594f012) | 8 | 0 | 4 | 0 | 0 |
| [spacelift-flows-apps/flows-app-cloudflare](https://github.com/spacelift-flows-apps/flows-app-cloudflare/tree/a75faa2758c9d83c21be963f9cd56304641dd95d) | 4 | 0 | 3 | 0 | 0 |
| [streetwriters/notesnook](https://github.com/streetwriters/notesnook) | apply did not finish in 10 minutes | | | | |
| [sureboy/jscadwebsite](https://github.com/sureboy/jscadwebsite) | apply did not finish in 10 minutes | | | | |
| [surgent-dev/surgent](https://github.com/surgent-dev/surgent/tree/47944c9ed7c4dfd74c9ed121e902aaba776da67d) | 5 | 0 | 4 | 0 | 0 |
| [tidtulabs/tidtu](https://github.com/tidtulabs/tidtu/tree/fe8673333c485f5bb3c858c1d226aaa759e8e1cc) | 8 | 0 | 6 | 0 | 0 |
| [vaishnav-mk/workflows-plus-plus](https://github.com/vaishnav-mk/workflows-plus-plus) | apply did not finish in 10 minutes | | | | |
| [webview-bundle/webview-bundle](https://github.com/webview-bundle/webview-bundle/tree/9d6c942e1d6e3e748705c06571a4032294d50e15) | 3 | 0 | 2 | 0 | 0 |
| [wriddhi/bskypt](https://github.com/wriddhi/bskypt/tree/d61c3ea52d453456edb07f5a3dc8674801750b79) | 4 | 0 | 3 | 0 | 0 |

### Type errors still present after migration, by kind

- type mismatch: 60
- TS2307: 41
- TS2558: 6
- TS2353: 5
- TS2554: 4
- TS2559: 2
- TS18048: 1
- missing property `result`: 1
- missing property `nextPageParams`: 1

### Why sites were queued

- receiver of <call> cannot be traced to cloudflare: 33
- arguments of <call> could have side effects and moving them would change their order: 29
- workers.scripts.deployments.get is not called with 2 positional arguments: 3
- queues.consumers.get is not called with 2 positional arguments: 2
- the params argument of <call> is not an object literal, a name or a property read, so it cannot be spread: 1
- comments around the arguments of <call> would be lost: 1
- pages.projects.deployments.get is called with a spread argument: 1
- pages.projects.deployments.history.logs.get is called with a spread argument: 1
- workersForPlatforms.dispatch.namespaces.scripts.delete is not called with 2 positional arguments: 1

## Reproducing

```sh
node bench/run.mjs --rules bench/cloudflare-6-to-7/rules.json --repos bench/cloudflare-6-to-7-args/repos.json --work ../bench-work \
  --old cloudflare@6.5.0 --new cloudflare@7.0.0 --types @types/node@22
node bench/report.mjs ../bench-work/results.json
node bench/coverage.mjs --calls bench/cloudflare-6-to-7-args/calls.json --package cloudflare --work ../bench-work --receiver-types
```

Related docs are [benchmarks](../README.md), [matching](../../docs/matching.md) and [build log](../../docs/history.md).

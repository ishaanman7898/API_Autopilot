# Drafting rules

`apimigrate draft old.json new.json` compares two OpenAPI 3.x specs and drafts a rule file for a publisher to review. It is a starting point. It never produces a rule that can be signed as it stands.

```sh
node bin/apimigrate.js draft old.json new.json --provider acme --package acme-sdk --from 1 --to 2 --naming underscore --out draft-rules.json
```

It writes the rule file and a `draft-rules.report.json` beside it. Specs must be JSON. YAML is rejected with a message. Swagger 2 is rejected.

## What it detects

| Change | Result |
| --- | --- |
| Same method and route with a new `operationId`, one old and one new | A `rename-method` rule. |
| Only one unmatched old and one unmatched new operation with the same HTTP method | A `rename-method` rule marked as a guess. |
| Same `operationId`, different path | Listed in the report. No code rule, because the SDK method did not change. |
| Parameter or body field renamed, with the same location and type, one removed and one added | A `rename-param` rule. |
| Operation, parameter or field with no counterpart | A `manual` rule with a prompt. |
| New required parameter or field | A `manual` rule. |
| Changed type, format, enum or nullability | A `manual` rule that names both types. |
| Response field removed or changed | A `manual` rule. |

References such as `$ref` and `allOf` are resolved inside the document. Cycles and dangling references are treated as empty. `oneOf` and `anyOf` are treated as opaque.

## Confidence

Every rule carries `confidence` and `evidence`. The draft never says a rule is certain.

- `likely` means the evidence is structural and one to one, and the publisher stated the naming convention with `--naming`.
- `needs-review` means anything else. Without `--naming`, every method rename is `needs-review`, because the SDK method name is an assumption about how the generator names methods. Non-body parameter renames are always `needs-review`, because many SDKs take them as positional arguments.

`--naming underscore` maps `charges_create` to `charges.create`. `--naming identity` uses the `operationId` as the call.

## From two SDK versions

SDKs generated in the Stainless style ship `api.md` files that list every client method with the endpoint it calls, and every type with the file that defines it. Pass two checkouts of the SDK, for example at two release tags, and the draft is built from them instead of from OpenAPI.

```sh
git clone --depth 1 --branch v14.1.1 https://github.com/muxinc/mux-ts.git old
git clone --depth 1 --branch v15.0.0 https://github.com/muxinc/mux-ts.git new
node bin/apimigrate.js draft old new --provider mux --out draft-rules.json
```

The package name and versions come from each checkout's `package.json` unless `--package`, `--from` or `--to` are given.

| Change | Result |
| --- | --- |
| A method keeps its endpoint but has a new call path | A `rename-method` rule, `likely`. |
| Every method under a prefix moved the same way, such as `robotsPreview.*` to `robots.*` | One `rename-namespace` rule, `likely`. |
| Every type and method defined under one directory is defined under another | A `rename-import` rule for that subpath, `likely`, placed before the package rename. When only some of them moved, there is no rule, since a `rename-import` also matches every subpath. The report lists it under `partialModuleMoves`. |
| The package name changed | A `rename-import` rule for the package, `likely`. |
| An endpoint is gone | A `manual` rule, `needs-review`, naming the closest method with the same name as a likely replacement. |
| Leading positional arguments moved into the params object, each matching a path parameter of the endpoint | A `positional-to-named` rule, `likely`. |
| Any other change to the arguments a caller passes | A `manual` rule, `needs-review`, with both argument lists. Renamed placeholders, such as `memberId` to `memberID`, are not changes. |
| The name or version changed | A `rename-dependency` rule to the new name at `^` the new version, `likely`. |

Added methods, changed return types and removed types are listed in the report. On Mux 14.1.1 to 15.0.0 this drafts 5 rules: the `resources/robots-preview` subpath move, the rename to `@mux/ts`, `robotsPreview` to `robots`, a manual rule for `data.filters.listValues` that suggests `data.dimensions.listValues`, and the dependency.

## From npm releases

`apimigrate watch` makes the same draft without checkouts when it finds a new major version and the provider publishes no signed rules. It fetches each release's `api.md` files from GitHub, at the commit npm recorded when the release was published or at its release tag. On `@mux/mux-node` 14.1.1 to 15.5.0 it drafts the same 5 rules as above. On `cloudflare` 6.5.0 to 7.3.0 it drafts 274, 21 of them `needs-review`, and lists 6 partial module moves, such as one type moving from `resources/dns` into `resources/dns/dnssec`, without drafting rules for them. When neither release has an `api.md`, it drafts from their TypeScript declarations instead, as described below. These drafts are never signed. They reach a repository only as draft pull requests marked unsigned. See [CLI reference](cli.md#watch).

## From TypeScript declarations

Packages without `api.md` files, such as zod, still publish TypeScript declarations. When neither release has an `api.md`, `watch` drafts from the declarations in both npm tarballs. It builds a program over the `.d.ts`, `.d.mts` and `.d.cts` files with the TypeScript compiler, resolves each subpath in the `package.json` `exports` as TypeScript would, and compares the two releases subpath by subpath. It reads each export, whether it is a value or only a type, the argument counts of functions and static members, the public methods of exported classes and interfaces with their argument counts, and `@deprecated` notes. Names that start with `_`, private and protected members, and members every object has, such as `toString`, are left out.

| Change | Result |
| --- | --- |
| A function or method is gone, the old release's `@deprecated` note says only "Use X", "Renamed to X" or the same after "since <version>", X is in the new release where the old one was and takes every argument count the old one did, and nothing with the old name is left anywhere in the new release | A `rename-method` rule, `likely`. |
| Any other function, method or static member that is gone | A `manual` rule, `needs-review`. |
| A function or method needs more arguments, or takes fewer than the old one required | A `manual` rule, `needs-review`. |
| An optional argument was dropped | Listed in the report under `optionalArgumentsDropped`. |
| A class, constant, namespace or type is gone | Listed in the report. A manual rule matches calls, and these are used with `new`, `instanceof` or as types. |
| The default export or a subpath is gone, or an exports map is added | Listed in the report, and in the pull request under "Not covered by any rule". |
| A name is newly deprecated | Listed in the report under `deprecatedInNewVersion`. |
| The version changed | A `rename-dependency` rule to `^` the new version, `likely`. |

The engine matches a call by its path, such as `del` on an instance or `ZodString.create`, not by class or subpath. So a name left anywhere in the new release, even under a legacy subpath, blocks a rename. A change only in a subpath other than the root is dropped when the root still has the name. `@deprecated` notes are package text, so they appear in each rule's evidence for the reviewer and never in a prompt.

On `lru-cache` 7.18.3 to 11.5.3 this drafts 4 rules: `del` to `delete`, `prune` to `purgeStale` and `reset` to `clear`, from the old release's deprecation notes, and the dependency. The report also says the default export is gone, which no rule can rewrite, so `import LRU from 'lru-cache'` still has to become `import { LRUCache } from 'lru-cache'` by hand. On `zod` 3.25.76 to 4.6.7 it drafts 85 rules, 84 of them `needs-review`: 13 removed methods such as `deepPartial`, `nonstrict`, `ip` and `augment`, 18 removed functions such as `ostring`, `z.record` now needing two arguments, `ZodError.addIssues` now needing one, and 51 removed static members, 41 of them factories such as `ZodString.create` that applications rarely call. It drafts no rename for zod. `augment` is marked "Use `.extend` instead", but zod 4 still ships the old API under `zod/v3`, where `augment` exists. Changes inside option objects, such as `message` becoming `error`, and changes in behavior do not show in the declarations and are not found.

## Before signing

`sign` refuses a file with `draft: true` or any `confidence` field. The publisher reads each rule, checks it against the real SDK, fixes it, and removes the marks. `lint` reports what still blocks signing.

## Limits

- It cannot know how a given SDK generator names things. That is why the naming flag exists.
- Operations are matched by `operationId` or by method and route. Heavy restructuring will show up as removals and additions.
- Only the first 2xx response and the JSON request body are compared. Other media types are compared only if they are the first listed.
- It does not see behavior changes that the spec does not describe.

Related docs are [rule format](rule-format.md), [CLI reference](cli.md) and [matching](matching.md).

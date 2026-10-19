# Cloudflare rule kit

This folder is a ready to publish rule set for the `cloudflare` SDK 6 to 7 upgrade. It is unsigned on purpose. Only Cloudflare can sign it, because the signature is what tells a consumer the change comes from Cloudflare.

[cloudflare-6-to-7.rules.json](cloudflare-6-to-7.rules.json) holds the 254 rules from the [Cloudflare benchmark](../../bench/cloudflare-6-to-7/README.md). There are 240 `positional-to-named` rules for methods whose leading path parameters became keys of the params object, 11 `rename-method` rules such as `getByIds` to `getByIDs`, 2 `manual` rules for irregular changes and a `rename-dependency` to `^7.0.0`. In the benchmark they ran on 12 public repositories, broke nothing and updated every `package.json`. None of those repositories called an affected method. The [argument benchmark](../../bench/cloudflare-6-to-7-args/README.md) ran the same rules on 63 repositories that do: 39 of the 240 `positional-to-named` rules rewrote 154 calls and fixed 128 of the 246 type errors the upgrade causes, and 4 of the rewrites introduced 5 new ones.

## What Cloudflare should check before signing

1. The rules were drafted by comparing the 6.5.0 and 7.0.0 SDKs, not taken from Cloudflare. Check a sample of the 240 `positional-to-named` rules, especially the names given to the moved parameters. In the [argument benchmark](../../bench/cloudflare-6-to-7-args/README.md) 39 of them fired, and for each the moved names are required keys of the 7.0.0 params type. Of their 154 rewrites, 1 is wrong: it spread a `JSON.stringify(...)` string into the params object of a `kv.namespaces.values.update` call that 6.5.0 already rejected, and should have been queued. 3 more are right at run time but keep a `Parameters<typeof method>[2]` cast, which names `RequestOptions` in 7.0.0, so they no longer type-check, and 5 put the moved key before a spread that already has it, which `strict` builds report as TS2783. These faults are in the engine, not the rules. Two kinds of rule need a look: the rules for 6 methods that also had an `(a, b, options?)` overload in 6.5.0, such as `rulesets.rules.delete`, would merge request options passed there into params, and the rule for `tenantCustomNameservers.delete`, whose 6.5.0 form `delete(tenantTag, customNSId, options?)` takes no params, always would. No call in the benchmark hit either.
2. The two `manual` rules cover `workersForPlatforms.dispatch.namespaces.scripts.tags.update` and `zeroTrust.dlp.datasets.versions.create`. Confirm the prompts, or turn them into rules.
3. Other changes in the migration guide may lack a rule. Say which. The [argument benchmark](../../bench/cloudflare-6-to-7-args/README.md) found 22 type errors from changes no rule covers: imports from `cloudflare/core`, `cloudflare/core.mjs` and `cloudflare/src/*`, the client's `get` and `put` taking one type argument instead of two, `nextPageParams()`, and the removed `zones.list(options)` overload. Version 7.0.0 ships its own codemod, `npx cloudflare migrate`, which was not compared with this kit.
4. The sunset date is 2027-12-31. Pick the date after which you no longer want consumers to apply the rule.

## Publishing steps

Run these from a checkout of this project, with your own key folder.

```
apimigrate keygen --out cf-keys --key-id cloudflare-2026
apimigrate lint cloudflare-6-to-7.rules.json
apimigrate sign cloudflare-6-to-7.rules.json --key cf-keys/apimigrate-private.pem --key-id cloudflare-2026
mkdir site
cp cloudflare-6-to-7.rules.json site/
cp cf-keys/apimigrate-keys.json site/keys.json
apimigrate index site --base-url https://cloudflare.com/rules --keys site/keys.json --out site/index.json
```

Keep the private key out of any repository. Then host three files over HTTPS.

| File | URL |
| --- | --- |
| Key set, from `cf-keys/apimigrate-keys.json` | `https://cloudflare.com/.well-known/apimigrate-keys.json` |
| Rule index, from `site/index.json` | `https://cloudflare.com/.well-known/apimigrate-rules.json` |
| Signed rules | `https://cloudflare.com/rules/cloudflare-6-to-7.rules.json` |

Use your real domain and base URL in place of the ones above. The index and the key set must be on the same domain, because `watch` checks each rule file against that domain's keys.

## What a consumer does

```
sources:
  - "cloudflare cloudflare.com"
providers:
  - cloudflare
```

Put that in `.apimigrate.yml`. Each `sources` entry is the package and the domain that serves its index, here the example domain from the publishing steps. `watch` then finds the new major on npm, reads the index on that domain, checks the signature against the same domain's key set and opens a draft pull request. Nothing is merged for them. Because `providers` lists only `cloudflare`, rules from anyone else are skipped, including the unsigned drafts `watch` makes for other dependencies. Leave `providers` out to keep those drafts.

## Status

The flow from `lint` to `index` is tested with a throwaway key. No domain serves this index yet, so the live fetch against a provider domain is still unverified.

Related docs are [rule format](../../docs/rule-format.md), [CLI reference](../../docs/cli.md#index) and [strategy](../../docs/strategy.md).

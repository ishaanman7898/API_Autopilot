# Mux rule kit

This folder is a ready to publish rule set for the `@mux/mux-node` 14 to `@mux/ts` 15 upgrade. It is unsigned on purpose. Only Mux can sign it, because the signature is what tells a consumer the change comes from Mux.

[mux-node-14-to-15.rules.json](mux-node-14-to-15.rules.json) holds the five rules from the [Mux benchmark](../../bench/mux-14-to-15/README.md). In that benchmark they fixed every type error the upgrade caused on 32 public repositories, introduced none, and updated every `package.json`.

## What Mux should check before signing

1. The `manual` rule for `data.filters.listValues` names `data.dimensions.listValues` as a likely replacement. That comes from the SDK diff, not from Mux. Confirm it or change the prompt.
2. Rewriting moved type names inside type positions, such as `Mux.RobotsPreview.Job`, is not covered yet. Say whether other renames in the migration guide need a rule.
3. The sunset date is 2027-12-31. Pick the date after which you no longer want consumers to apply the rule.

## Publishing steps

Run these from a checkout of this project, with your own key folder.

```
apimigrate keygen --out mux-keys --key-id mux-2026
apimigrate lint mux-node-14-to-15.rules.json
apimigrate sign mux-node-14-to-15.rules.json --key mux-keys/apimigrate-private.pem --key-id mux-2026
mkdir site
cp mux-node-14-to-15.rules.json site/
cp mux-keys/apimigrate-keys.json site/keys.json
apimigrate index site --base-url https://mux.com/rules --keys site/keys.json --out site/index.json
```

Keep the private key out of any repository. Then host three files over HTTPS.

| File | URL |
| --- | --- |
| Key set, from `mux-keys/apimigrate-keys.json` | `https://mux.com/.well-known/apimigrate-keys.json` |
| Rule index, from `site/index.json` | `https://mux.com/.well-known/apimigrate-rules.json` |
| Signed rules | `https://mux.com/rules/mux-node-14-to-15.rules.json` |

Use your real domain and base URL in place of the ones above. The index and the key set must be on the same domain, because `watch` checks each rule file against that domain's keys.

## What a consumer does

```
sources:
  - "@mux/mux-node mux.com"
providers:
  - mux
```

Put that in `.apimigrate.yml`. Each `sources` entry is the package and the domain that serves its index, here the example domain from the publishing steps. `watch` then finds the new major on npm, reads the index on that domain, checks the signature against the same domain's key set and opens a draft pull request. Nothing is merged for them. Because `providers` lists only `mux`, rules from anyone else are skipped, including the unsigned drafts `watch` makes for other dependencies. Leave `providers` out to keep those drafts.

## Status

The flow from `lint` to `index` was rehearsed with a throwaway key and works. No domain serves this index yet, so the live fetch against a provider domain is still unverified.

Related docs are [rule format](../../docs/rule-format.md), [CLI reference](../../docs/cli.md#index) and [strategy](../../docs/strategy.md).

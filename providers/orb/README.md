# Orb rule kit

This folder is a ready to publish rule set for the `orb-billing` SDK 5 to 6 upgrade. It is unsigned on purpose. Only Orb can sign it, because the signature is what tells a consumer the change comes from Orb.

[orb-billing-5-to-6.rules.json](orb-billing-5-to-6.rules.json) holds 23 rules drafted by `apimigrate draft` from the `api.md` files of 5.76.0 and 6.0.0, with the review marks removed. There are 11 `rename-method` rules for names such as `customers.fetchByExternalId` to `customers.fetchByExternalID`, 4 `rename-namespace` rules such as `beta.externalPlanId` to `beta.externalPlanID`, 7 `positional-to-named` rules for methods whose leading path parameter moved into the params object, and a `rename-dependency` to `^6.0.0`. The draft marked all 23 as `likely` and found no endpoint removals.

The package gets about 87,000 downloads a week on npm.

## What Orb should check before signing

1. This kit has not been benchmarked. Unlike the [Mux](../mux/README.md) and [Cloudflare](../cloudflare/README.md) kits, it has not run on any public repository, so nothing here shows it breaks nothing.
2. The 6.0.0 changelog calls the release a migration to the Stainless v2 TypeScript SDK architecture. The rules only cover changes visible in `api.md`, which are method and path renames and moved path parameters. Client options, error classes, types, exports, pagination helpers and runtime requirements are not covered. Orb ships no migration guide, so say which of those break callers and add rules or notes.
3. The 7 `positional-to-named` rules take the parameter names from the SDK diff. Check each one against the API.
4. The sunset date is 2027-12-31. Pick the date after which you no longer want consumers to apply the rule.

## Publishing steps

Run these from a checkout of this project, with your own key folder.

```
apimigrate keygen --out orb-keys --key-id orb-2026
apimigrate lint orb-billing-5-to-6.rules.json
apimigrate sign orb-billing-5-to-6.rules.json --key orb-keys/apimigrate-private.pem --key-id orb-2026
mkdir site
cp orb-billing-5-to-6.rules.json site/
cp orb-keys/apimigrate-keys.json site/keys.json
apimigrate index site --base-url https://withorb.com/rules --keys site/keys.json --out site/index.json
```

Keep the private key out of any repository. Then host three files over HTTPS.

| File | URL |
| --- | --- |
| Key set, from `orb-keys/apimigrate-keys.json` | `https://withorb.com/.well-known/apimigrate-keys.json` |
| Rule index, from `site/index.json` | `https://withorb.com/.well-known/apimigrate-rules.json` |
| Signed rules | `https://withorb.com/rules/orb-billing-5-to-6.rules.json` |

Use your real domain and base URL in place of the ones above. The index and the key set must be on the same domain, because `watch` checks each rule file against that domain's keys.

## What a consumer does

```
sources:
  - orb-billing
providers:
  - orb
```

Put that in `.apimigrate.yml`. `watch` then finds the new major on npm, reads the index, checks the signature and opens a draft pull request. Nothing is merged for them.

## Status

The flow from `lint` to `index` is tested with a throwaway key. No domain serves this index yet, so the live fetch against a provider domain is still unverified.

Related docs are [rule format](../../docs/rule-format.md), [CLI reference](../../docs/cli.md#index), [drafting rules](../../docs/draft.md) and [strategy](../../docs/strategy.md).

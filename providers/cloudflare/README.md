# Cloudflare rule kit

This folder is a ready to publish rule set for the `cloudflare` SDK 6 to 7 upgrade. It is unsigned on purpose. Only Cloudflare can sign it, because the signature is what tells a consumer the change comes from Cloudflare.

[cloudflare-6-to-7.rules.json](cloudflare-6-to-7.rules.json) holds the 254 rules from the [Cloudflare benchmark](../../bench/cloudflare-6-to-7/README.md). There are 240 `positional-to-named` rules for methods whose leading path parameters became keys of the params object, 11 `rename-method` rules such as `getByIds` to `getByIDs`, 2 `manual` rules for irregular changes and a `rename-dependency` to `^7.0.0`. In the benchmark they ran on 12 public repositories, broke nothing and updated every `package.json`. None of those repositories called an affected method, so the argument rewrites were not exercised on real code there.

## What Cloudflare should check before signing

1. The rules were drafted by comparing the 6.5.0 and 7.0.0 SDKs, not taken from Cloudflare. Check a sample of the 240 `positional-to-named` rules, especially the names given to the moved parameters.
2. The two `manual` rules cover `workersForPlatforms.dispatch.namespaces.scripts.tags.update` and `zeroTrust.dlp.datasets.versions.create`. Confirm the prompts, or turn them into rules.
3. Other changes in the migration guide may lack a rule. Say which.
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
  - cloudflare
providers:
  - cloudflare
```

Put that in `.apimigrate.yml`. `watch` then finds the new major on npm, reads the index, checks the signature and opens a draft pull request. Nothing is merged for them.

## Status

The flow from `lint` to `index` is tested with a throwaway key. No domain serves this index yet, so the live fetch against a provider domain is still unverified.

Related docs are [rule format](../../docs/rule-format.md), [CLI reference](../../docs/cli.md#index) and [strategy](../../docs/strategy.md).

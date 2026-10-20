# Message to the Cloudflare SDK maintainers

Draft for an issue or email. Send it from your own account.

Subject. A signed migration for the cloudflare SDK 6 to 7 upgrade

Hello,

I build apimigrate, an open source tool that applies a provider's signed migration rules to consumer repositories and opens draft pull requests with evidence. I drafted 254 rules for the 6 to 7 upgrade by comparing the two SDK releases. They cover 240 methods whose arguments changed, 11 renamed methods, 2 irregular changes that need a person, and the dependency bump. I ran them on 12 public repositories that use `cloudflare` 6. They broke nothing and updated every `package.json`. None of those repositories called an affected method, so I ran the rules again on 63 public repositories that do. They rewrote 149 calls, fixed 125 of the 246 type errors the upgrade causes and introduced none, after I fixed two engine faults the first run exposed, and queued 72 calls for a person. The method and raw results are in the benchmark folder of the repository.

Two things I would like from you.

1. Review the rules, in particular the names given to moved parameters and the two manual rules.
2. If they look right, sign them with a Cloudflare key and host the key set and index on your domain. The steps take about ten minutes and are in the Cloudflare rule kit.

Consumers would then get a draft pull request for the upgrade that you vouch for. Nothing is merged for them, and you can set a sunset date or revoke the key at any time.

I can answer questions or adjust the rules. If this is not useful, I would also like to hear why.

Thanks,
Ishaan

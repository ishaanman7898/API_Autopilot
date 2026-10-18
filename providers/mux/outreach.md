# Message to the Mux SDK maintainers

Draft for an issue or email. Send it from your own account.

Subject. A signed migration for the mux-node to @mux/ts upgrade

Hello,

I build apimigrate, an open source tool that applies a provider's signed migration rules to consumer repositories and opens draft pull requests with evidence. I ran drafted rules for the 14 to 15 upgrade on 32 public repositories that use `@mux/mux-node`. They fixed all 4 type errors the upgrade caused, introduced none, and updated every `package.json`. The method and raw results are in the benchmark folder of the repository.

Two things I would like from you.

1. Review the five rules, in particular the replacement for `data.filters.listValues`.
2. If they look right, sign them with a Mux key and host the key set and index on your domain. The steps take about ten minutes and are in the Mux rule kit.

Consumers would then get a draft pull request for the upgrade that you vouch for. Nothing is merged for them, and you can set a sunset date or revoke the key at any time.

I can answer questions or adjust the rules. If this is not useful, I would also like to hear why.

Thanks,
Ishaan

# Message to the Orb SDK maintainers

Draft for an issue or email. Send it from your own account.

Subject. A signed migration for the orb-billing 5 to 6 upgrade

Hello,

I build apimigrate, an open source tool that applies a provider's signed migration rules to consumer repositories and opens draft pull requests with evidence. I drafted 23 rules for the `orb-billing` 5 to 6 upgrade by comparing the `api.md` files of 5.76.0 and 6.0.0. They cover 11 method renames such as `fetchByExternalId` to `fetchByExternalID`, 4 renamed namespaces, 7 methods whose leading path parameter moved into the params object, and the dependency bump.

I have not run them on public repositories yet, and they cannot see changes that `api.md` does not show. The 6.0.0 changelog mentions a move to the Stainless v2 architecture and I found no migration guide.

Two things I would like from you.

1. Review the rules, and tell me which other changes in 6.0.0 break callers.
2. If they look right, sign them with an Orb key and host the key set and index on your domain. The steps take about ten minutes and are in the Orb rule kit.

Consumers would then get a draft pull request for the upgrade that you vouch for. Nothing is merged for them, and you can set a sunset date or revoke the key at any time.

I can answer questions or adjust the rules. If this is not useful, I would also like to hear why.

Thanks,
Ishaan

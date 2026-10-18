# Strategy

This page says where the project is going and what could make it last. It is a plan, not a record of results. Claims about the market are judgments, and each one names what would prove it wrong.

## The problem with the obvious pitch

A coding agent can already read a changelog and migrate a repository. The code in this repository is MIT licensed and small, so anyone can copy it. If the pitch is that the tool upgrades dependencies, it loses to a general agent that improves every few months and costs nothing to try.

What an agent does not give you is any of the following.

1. A reason to trust the change. An agent's pull request is a claim. A signed rule applied by a deterministic engine is a checkable statement from the party that made the breaking change.
2. The same answer twice. Agent output differs per run, per model and per prompt. Rule output can be replayed byte for byte.
3. A cost that falls with scale. An agent pays full price for every repository. A rule is written once by the provider and applied by thousands of consumers at close to zero cost.
4. A defense against its own shortcuts. Agents make a failing suite pass by weakening tests. The gate exists to catch that, and it applies to the agent fallback too.

These are the real assets. Matching and rewriting are not.

## What is and is not a moat

Weak, because they can be copied or replaced.

- The engine and the CLI. Open source and small.
- The rule format alone. A format with no publishers is a document.
- Draft rules from release notes. A model can do this, and so can any competitor.

Plausible, because they depend on other parties and on time.

- Provider publication. If providers sign and host rules for their own breaking releases, consumers have a reason to use the one engine that verifies them. This is the same pattern as signed packages and published changelogs. Once a provider has a rule index, switching away costs the provider nothing, but switching away from the format costs every consumer their trust setup, pins and CI. That is a network effect, and it is the main bet.
- A verified corpus. Every migration run against a real repository with a type check and a test run is a data point on whether a rule is correct. A public record of which rules were applied to how many repositories with what outcome is hard to rebuild and useful to the next consumer and to the provider fixing a bad rule.
- The trust and audit trail. Security and platform teams need a record that a dependency change was reviewed, replayable and gated. Evidence bundles, pinned hashes and key windows are that record. Agents do not produce it by default.
- Being the neutral party. A provider will not hand its migration path to a rival's product. An open format with a signed index, owned by no vendor, is easier to adopt.

None of these is proven. The next phases exist to test them cheaply.

## Positioning

The tool is not an AI product and should not compete as one. It is the verification and distribution layer that AI agents and humans both use.

- With an agent, the tool is the safe path. The agent proposes, the engine proves, the gate checks, and anything unproven goes to a queue. The agent fallback already works this way.
- Without an agent, the tool is a deterministic codemod that comes with a signature.
- For a provider, the tool is the way to ship a breaking change with a migration attached.

This framing turns the rise of agents into demand. The more code agents write, the more changes need an independent check that is not another agent.

## Plan

Each phase has an exit test. If it fails, stop and rethink before building the next one.

### Phase 1, make one provider real

Goal. One real provider publishes a signed rule index that the Action consumes.

- Pick a provider with a public SDK, frequent majors and an active maintainer. Mux and Cloudflare are already benchmarked, so start there.
- Offer to maintain the first rule set for them, signed with their key, in their repository.
- Publish the index on their domain and run `watch` against it for real.

Status. The kits are in [providers/mux](../providers/mux/README.md) and [providers/cloudflare](../providers/cloudflare/README.md), and the checklist is in the [plan](plan.md). The sign and index flow was rehearsed with a throwaway key. Neither provider has been contacted and no domain serves an index yet.

Exit test. A pull request opened by the Action from a provider signed index, merged by a real consumer.

### Phase 2, prove the numbers on more targets

Goal. Show the result holds beyond two SDKs.

- Add benchmarks for five more upgrades across different ecosystems, chosen by download count and by how often the major breaks users.
- Report the same numbers every time. Type errors fixed, type errors introduced, call sites proven and call sites queued.
- Publish failures. A benchmark that only shows wins will not be believed.

Exit test. Seven benchmarks, zero introduced type errors in at least six, with the failures written up.

### Phase 3, grow the language base

Goal. Stop being a JavaScript and TypeScript tool.

- The rule format and the evidence model are language neutral. Matching is not.
- Add one more language through its own checker or language server. Python with a type checker is the likely first step, since Python SDK breaks are common.
- Keep the rule that unproven call sites go to the queue.

Exit test. One non JavaScript benchmark with the same reporting as above.

### Phase 4, make trust easy to adopt

Goal. Remove the reasons a security team would say no.

- Add a transparency log for rule publication so a key cannot sign two different rules for one version without it being visible.
- Support committing and updating a key set, with a clear flow for rotation and revocation.
- Produce an evidence format that other tools can read, such as an attestation that fits existing supply chain tooling.
- Get an outside review of the signing and fetch code.

Exit test. A written external review, with findings fixed or documented.

### Phase 5, rule authoring for providers

Goal. Make writing a rule cheaper than writing a migration guide.

- Improve `draft` so a provider can start from an OpenAPI or type declaration diff and review rather than write.
- Add a rule test format, so a provider ships examples of before and after that the engine checks on every release.
- Add a command that checks a rule set against a corpus of public repositories before signing, using the benchmark runner.

Exit test. A provider other than the author publishes a rule set without help.

### Phase 6, the hosted side, only if the open side works

Goal. Earn money without closing the format.

- Candidates are a hosted rule index with analytics for providers, a managed Action for teams that want a dashboard of upgrades across repositories, and an audit export for compliance.
- The engine, format and signing stay open. Charge for operations and reporting, not for the right to verify.
- Do not build this before Phase 1 and Phase 2 are done. A hosted product around a format nobody publishes has no customers.

Exit test. Three teams use the hosted side in place of the open Action and say what they would pay.

## Risks

- Providers never publish rules. The mitigation is drafted rules from release notes, which already work, but they are unsigned and weaker. If no provider publishes after Phase 1 with real effort, the project is a codemod tool and should be positioned as one.
- General agents become reliable enough that no one wants a rule at all. Then the value moves to verification and audit alone, which the gate and evidence already provide, and the project should lead with those.
- A large platform ships the same thing. Dependency update bots and code hosts could add signed migrations. The defense is an open format they adopt, and speed to a real provider and a real corpus.
- A bad signed rule does damage at scale. A trust system makes a bad rule more believable. The pins, key windows, revocation and the gate limit the harm, but a transparency log and a rule test format are needed before wide use.
- Maintenance load. Every language and every provider adds work. Say no to language support that cannot meet the proven or queued rule.

## What to measure

- Number of providers publishing signed rules.
- Number of consumer repositories that merged a pull request from a signed index.
- Share of call sites proven rather than queued, per benchmark.
- Type errors introduced, which must stay at zero.
- Gate catches, meaning pull requests where the gate blocked a weakened test.
- Time from a provider release to the first merged consumer pull request.

Stars and downloads are not on this list. They do not show that the trust claim holds.

## What not to do

- Do not claim the tool is safe to merge unseen. Pull requests stay drafts.
- Do not sell the agent fallback as the product. It is the part most easily replaced.
- Do not add unsigned rules to the signed path to look more complete.
- Do not report a benchmark without its failures.

Related docs are [overview](overview.md), [security](security.md), [build log](history.md) and the [benchmarks](../bench/README.md).

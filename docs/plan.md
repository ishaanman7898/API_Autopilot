# Plan

This is the working checklist for Phase 1 of the [strategy](strategy.md). It lists what is done, what the maintainer does next, and what to do if there is no answer. Nothing here needs new code.

## Done

- A signed rule format, an engine, a gate, evidence and replay, a draft command, a watcher and an Action.
- A Mux kit in [providers/mux](../providers/mux/README.md) with 6 rules, publishing steps and a draft message.
- A Cloudflare kit in [providers/cloudflare](../providers/cloudflare/README.md) with 254 rules, publishing steps and a draft message. The [Cloudflare argument benchmark](../bench/cloudflare-6-to-7-args/README.md) ran it on 63 repositories that call the changed methods: it rewrote 154 calls, fixed 128 of the 246 type errors the upgrade causes, introduced 5 and queued 67 calls.
- An Orb kit in [providers/orb](../providers/orb/README.md) with 23 rules drafted from `orb-billing` 5.76.0 and 6.0.0, publishing steps and a draft message. The [Orb benchmark](../bench/orb-5-to-6/README.md) ran it on 3 repositories: it fixed 4 of the 13 type errors the upgrade causes, introduced none, and left 9 that no rule covers without queuing them.
- A test that each kit lints, signs with a throwaway key and builds an index.

## Not done

- No provider has been contacted.
- No provider's domain serves a rule index. The live fetch works against a test domain in the `provider-selftest` workflow.
- The rules are drafted from SDK diffs. No provider has reviewed them.
- The Orb kit misses changes that `api.md` does not show, such as error class constructors and a removed `orb-billing/core` export, and 20 of its 23 rules matched nothing in the 3 public codebases found calling version 5.
- The Cloudflare argument rewrites introduced 5 type errors in 2 of the 63 repositories of the [argument benchmark](../bench/cloudflare-6-to-7-args/README.md), because the engine spread a string into a params object and kept casts written for the old argument positions, and 5 more that only `strict` builds report. The engine also queued 31 calls whose receiver the TypeScript checker types as the client and 15 whose arguments are safe to move, missed 14 calls, and could not finish 4 of the 67 repositories: 3 timed out on minified files and 1 ran out of memory.

## Steps for the maintainer

### 1. Check the project on your machine

```
cd API_Autopilot
git pull
npm ci
npm test
```

Expect no failures. A few tests are skipped on purpose.

### 2. Rehearse the provider flow

This uses a throwaway key and publishes nothing. Run it in PowerShell from the repo root. Swap the file name for the Cloudflare kit to rehearse that one.

```
$r="rehearsal"; New-Item -ItemType Directory -Force "$r\site" | Out-Null; node bin/apimigrate.js keygen --out "$r\k" --key-id demo; Copy-Item providers\mux\mux-node-14-to-15.rules.json "$r\site\"; node bin/apimigrate.js lint "$r\site\mux-node-14-to-15.rules.json"; node bin/apimigrate.js sign "$r\site\mux-node-14-to-15.rules.json" --key "$r\k\apimigrate-private.pem" --key-id demo; Copy-Item "$r\k\apimigrate-keys.json" "$r\site\keys.json"; node bin/apimigrate.js index "$r\site" --base-url https://example.com/rules --keys "$r\site\keys.json" --out "$r\site\index.json"; Get-Content "$r\site\index.json"
```

Then delete the folder so the throwaway private key is never committed.

```
Remove-Item -Recurse -Force rehearsal
```

### 3. Contact the providers

1. Read `providers/mux/outreach.md` and send it as an issue on the `muxinc/mux-ts` repository, or by email. This is outward facing and goes out under your name.
2. Read `providers/cloudflare/outreach.md` and send it as an issue on the `cloudflare/cloudflare-typescript` repository, or by email.
3. Read `providers/orb/outreach.md` and send it as an issue on the `orbcorp/orb-typescript` repository, or by email.
4. If a provider agrees, send them the README from its kit. They run the publishing steps with their own key. You never hold their private key.

### 4. Turn on private vulnerability reporting

In the repository on GitHub, open Settings, then Code security, and enable private vulnerability reporting. [SECURITY.md](../SECURITY.md) tells people to use it.

### 5. Wait, then decide

Give each provider one to two weeks.

- If one agrees, help them publish and then run `watch` against their domain. That run is the exit test of Phase 1, a pull request opened from a provider signed index and merged by a real consumer.
- If none of the three agrees or answers, ask each what made it a poor fit. Three providers declining is the point where the project is treated as a codemod and audit tool that leads with the gate and evidence, as the [strategy](strategy.md) says. Building a kit for another provider with frequent major releases is still worth it if a reply points to a better fit.

## Then

Start Phase 2, more benchmarks with published failures. Fix the engine failures that the [Cloudflare argument benchmark](../bench/cloudflare-6-to-7-args/README.md) published, starting with the rewrites that introduced type errors and the timeouts on minified files, and run it again.

Related docs are [strategy](strategy.md), [build log](history.md) and the [CLI reference](cli.md).

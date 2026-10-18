# Overview

## The problem

Anyone who ships something other people build on will eventually break it. An API provider renames a method, a library drops an option, a framework changes a config key. Every downstream user then does the same migration by hand, and each of them does it a little differently.

## The idea

The publisher of the change writes the migration once, as a signed rule file. Each consumer applies it with a tool that rewrites only what it can prove, queues the rest, and produces evidence a reviewer can replay.

| Role | What they do |
| --- | --- |
| Publisher | Writes and signs a rule file and publishes a key set at `/.well-known/apimigrate-keys.json`. |
| Consumer | Runs `apimigrate apply` on their own machine or CI. Code does not leave it. |
| Reviewer | Reads the pull request, then replays it with `apimigrate verify`. |

## What it is not

It is not a general coding agent. An agent is the fallback for call sites the rules cannot prove. The value is the signed rule, the narrow deterministic engine, the gate and the evidence.

It does not decide what a breaking change is. A publisher writes the rule, or drafts one from two OpenAPI specs and reviews it.

## Beyond APIs

Nothing in the rule format is specific to HTTP APIs. A rule says where to look, what to change, what to hand to an agent, and when it expires. Code rules cover renamed imports, methods and parameters in JavaScript and TypeScript. Regex `replace` rules cover other text, such as config keys and flags, in named files. See `examples/webpack-4-to-5.rules.json`.

## Where to go next

Start with [rule format](rule-format.md) if you publish rules, or [CLI reference](cli.md) if you apply them. [Matching](matching.md) explains what counts as proven.

Related docs are [architecture](architecture.md), [security](security.md) and [build log](history.md).

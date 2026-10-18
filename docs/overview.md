# Overview

## The problem
Anyone who ships something other people build on will eventually break it: an API provider renames an endpoint, a library drops an option, a framework changes a config key, a CLI retires a flag. Every downstream user then does the same migration by hand, and each of them gets it a little differently.

## The idea
The **publisher** of the change writes the migration once, as a **signed rule file**. Every **consumer** applies it with an engine that is deterministic first, hands anything uncertain to an agent, and produces a **pull request they can verify**.

| Role | What they do |
| --- | --- |
| Publisher | Writes and signs a rule file, publishes their public key at `/.well-known/apimigrate-keys.json` |
| Consumer | Runs `apimigrate apply` in their own CI; code never leaves their runner |
| Reviewer | Reads the PR's evidence bundle and can replay it with `apimigrate verify` |

## What it is not
It is not a general coding agent. Agents are the fallback for call sites the rules cannot prove they handled. The value is the signed rule, the narrow deterministic engine, and the evidence.

## Why "universal"
Nothing in the rule format is specific to HTTP APIs. A rule is: *where to look*, *what to change*, *what to hand to an agent*, *when it expires*. That covers:

- SDK and API client upgrades (renamed methods, params, imports)
- Library and framework major versions (config keys, deprecated options)
- Build, CI and infrastructure config (webpack, ESLint, GitHub Actions, Terraform providers)
- CLI flag changes in scripts and Dockerfiles
- Internal platform changes (a company migrating its own teams off a deprecated internal library)

Use `"scope": "any"` and `replace` rules for anything that is not an import-gated code call. See [rule-format.md](rule-format.md) and `examples/webpack-4-to-5.rules.json`.

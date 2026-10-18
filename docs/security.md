# Security controls

This page lists what the tool does about each threat and where it stops. The threat model and how to report an issue are in [SECURITY.md](../SECURITY.md).

## Controls

| Threat | Control | Where it stops |
| --- | --- | --- |
| A forged or edited rule | ed25519 signature over a canonical hash. Keys come from the publisher. Optional `pins` of exact hashes. | A publisher whose key is stolen can sign anything until the key is revoked in the key set. |
| An old rule signed with a retired key | Keys have `notBefore`, `expires` and `revoked`. A key outside its window is refused. | The key set is fetched fresh each run, so revocation takes effect only when consumers fetch it. |
| A stale rule | A required `sunset` date. A missing or invalid date counts as expired. | The check uses the local clock. |
| A hostile or broken well-known response | HTTPS only, no redirects, 10 second timeout, 64 KB cap, strict shape checks. Any failure stops the run. | A compromised publisher domain serves whatever its owner wants. Pin hashes or commit the key set to avoid trusting the fetch. |
| Skipping verification | No key source is an error. `--allow-unsigned` is refused when pins are set and is recorded in the evidence. | The flag exists for local trials. |
| A rewrite that is not safe | AST based matching. Receivers must be traced to the package. Everything else is queued. | See [matching](matching.md) for what is and is not followed. |
| An agent that cheats | The gate fails on removed or skipped tests, weaker assertions, lower coverage, new secrets and edits to test or CI config. It applies to agent edits too. | See [gate](gate.md) for the patterns it knows. |
| Prompt injection through repo text | Context is cleaned, bounded and fenced. The agent can only edit files with queued sites. | Stripping is a heuristic. A consumer who runs a model with broad tools is exposed regardless. |
| Secrets added by a migration | Patterns for common token formats on added lines. Values are never printed. | Not an entropy check. |
| An opaque pull request | A deterministic evidence bundle, a replay command, and a head check. | Replay covers the deterministic pass only. |
| Path escape and symlinks | Paths must stay in the repository root. Symlinks are not followed. Writes outside the root are refused. | Case folding and Unicode normalization differences between file systems are not handled. |
| Untrusted action inputs | The action passes inputs through environment variables, stages only files named by the evidence, opens draft pull requests, and never merges. | The action has not been run on a real runner. |
| Silent behavior | Each apply and agent-apply appends to `.apimigrate/audit.log`. | The log is local and not tamper evident. |

## What the tool trusts

- The signature and the key set you point it at.
- Your `.apimigrate.yml`, and the command you give to `--test-cmd`, which runs with your permissions.
- The TypeScript compiler it embeds.

## What it does not protect against

- A malicious publisher with a valid key. A signed rule can still do something unwanted inside the rule kinds, for example rename a call to a harmful method. The gate and review are the defense, and nothing merges automatically.
- A regex `replace` rule is trusted as written. It is not parse-verified.
- A compromised runner or a compromised repository.

Related docs are [SECURITY.md](../SECURITY.md), [rule format](rule-format.md), [gate](gate.md) and [agent fallback](agent.md).

# Security and verification

| Concern | Control |
| --- | --- |
| A tampered or forged rule | ed25519 signature over a canonical content hash; keys published by the provider at a well-known URL; optional `pins` of exact rule hashes |
| A stale rule | Mandatory `sunset` date; expired rules are refused |
| Prompt injection through repo text, changelogs or specs | Text sent to the fallback agent is fenced as `<untrusted_repo_text>`, and a scanner flags instruction-like content (`injectionFindings`) |
| An agent that makes tests pass by deleting them | The gate fails when assertion count drops, a test file disappears, or line coverage falls |
| Secrets added by a migration | The gate scans added lines for AWS keys, private keys, GitHub, Slack and `sk-` tokens |
| Opaque changes | The evidence bundle records rule hash, key id, every call site, per-file before and after digests, gate and test results |
| "Trust me" PRs | `apimigrate verify` replays the deterministic pass on the base commit and compares a replay digest |
| Silent behaviour | `.apimigrate/audit.log` records each run |
| Over-broad access | The CLI and Action run on the customer's runner; the planned GitHub App is limited to branches and PRs |

## Limits
- The gate counts assertions with a regex tuned for JS and TS test styles (`expect`, `assert`, `.should`, `t.is`). Other languages need their own patterns.
- Replay covers the deterministic pass only. Agent edits are checked by the gate and tests, not replayed.
- The engine is regex-level, not AST-level. Rules scoped by import reduce false positives but do not eliminate them.
- Egress allowlisting and sandboxing the agent are runner responsibilities and not implemented here.

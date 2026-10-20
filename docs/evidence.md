# Evidence and replay

Every `apply` writes `.apimigrate/evidence.json`. The bundle is built so that two machines running the same rule on the same base commit produce the same bundle, apart from one timestamp.

## Contents

| Field | Meaning |
| --- | --- |
| `schema` | `apimigrate-evidence/2`. Older bundles are refused. |
| `rule` | The rule id, provider, content hash, whether it was signed, and the key id. |
| `tool` | The tool version and the parser version. |
| `scan` | The paths and extensions that were read. `verify` uses the same ones. |
| `callSites` | Every change, with file, line, rule and whether a parse proved it. |
| `unresolved` | Every queued site with its reason. |
| `skipped` | Files that were not touched, and why. |
| `deterministic` | SHA-256 digests of each file the engine changed, and a replay digest over them and the rule hash. |
| `files` | Digests of every file that differs from the base, including agent edits. |
| `agent` | Present after `agent-apply`. `edited`, digests of the files the agent edited, and `typecheck`, the type-check of those edits with `agent-apply --typecheck`, shaped like `typecheck` below without `baseline`, or null without the flag. |
| `gate` | The gate result, with each finding. |
| `tests` | The test command and its exit code, or null. |
| `install` | With `--install` or `--install-cmd`, each install command, its folder and exit code, and the digests of each lockfile it changed, or null. Changed lockfiles are committed with the pull request, and the head check compares them when they are among the scanned files. |
| `typecheck` | With `--typecheck`, `ran: true`, the TypeScript version, whether the original text was checked before the install (`baseline`), each config with the files checked under it, `added`, the errors the rewrite added on changed lines, which are also gate findings, and `otherLines`, new errors on lines it did not change. Each error has file, line, TypeScript code and message. When the check did not run, `ran: false` and the reason. Without the flag, null. |
| `meta.createdAt` | The only value that depends on the clock. |

## What makes it deterministic

- Text is read as LF with the byte order mark removed. The original line endings and mark are put back when files are written. Digests are over the normalized text.
- Paths use forward slashes and are sorted by code unit order.
- Findings, call sites and unresolved sites are sorted.
- Symbolic links are not followed, and paths cannot leave the repository root.
- No absolute paths, host names or times are recorded outside `meta`.

A test applies the same migration to LF and CRLF copies of a repository and checks that the bundles are equal. A test also checks that a different file order gives the same bundle.

## Replay

`apimigrate verify --rules rules.json --evidence evidence.json --root <base checkout>` does four things.

1. Checks the evidence schema.
2. Checks that the rule file hashes to the hash in the bundle.
3. Runs the deterministic pass on the base tree and compares the replay digest.
4. If you pass `--keys`, `--pubkey` or `--well-known`, verifies the rule signature too.

With `--head <checkout>` it also compares the head tree to the final digests in `files`. That catches edits made after the migration, including agent edits and deleted files. Without `--head`, verify cannot see them.

A mismatch prints the files that differ and exits with code 1.

## Limits

- Replay reproduces only the deterministic pass. Agent edits are not reproduced. They are checked by digest, by the gate and by your tests.
- The tool and parser versions are recorded but not enforced. Replaying with a different TypeScript version may differ in rare cases. A newer apimigrate that rewrites a rule kind differently reports "replay digest differs" for the files where its result differs.
- The bundle is not signed by the consumer. It proves consistency, not who produced it. Anyone who can write the pull request can write a bundle, which is why `verify` recomputes it and does not trust it.
- Determinism was tested on Windows. Tests simulate other line endings and orderings. Linux and macOS runs are defined in CI and have not been checked.

Related docs are [CLI reference](cli.md), [agent fallback](agent.md) and [GitHub Action](github-action.md).

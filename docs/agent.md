# Agent fallback

Call sites the engine cannot prove are written to `.apimigrate/unresolved.json`. The tool never calls a model itself. Whatever produces the edits, whether that is an agent or a person, hands back a file, and that file goes through the same gate as the deterministic edits.

## The queue

```json
{
  "schema": "apimigrate-queue/1",
  "rule": "acme-sdk-1-to-2",
  "items": [
    {
      "id": "cap#1",
      "file": "src/billing.ts",
      "line": 4,
      "ruleId": "cap",
      "reason": "manual rule: call site needs a migration",
      "task": "charges.capture was replaced by payments.confirm(id). Migrate the call.",
      "context": "<untrusted_repo_text>\n...\n</untrusted_repo_text>",
      "removedLines": [],
      "truncated": false
    }
  ],
  "overflow": 0
}
```

`task` comes from the signed rule and is trusted. `context` is repository text and is not.

## Treating context as untrusted

Before context is written, it is cleaned and bounded.

- Invisible and bidirectional control characters are removed.
- Lines that look like instructions to a model are replaced with a marker. Examples are lines that tell the reader to ignore earlier instructions, claim a new role, mention a system prompt, ask to send secrets, or pipe a download into a shell. The removed text is not echoed. `removedLines` lists only line numbers.
- Any text that looks like the fence tag is removed, so context cannot close the fence.
- Lines longer than 240 characters are cut. Each site is capped at 2000 bytes, the queue at 100,000 bytes and 200 sites. Sites beyond that are counted in `overflow`.
- The context is wrapped in `<untrusted_repo_text>` tags.

A consumer who feeds the queue to a model should put `task` in the instructions and `context` in clearly marked data, and should give the model no tools beyond returning a file. Stripping is a heuristic and will miss phrasing it does not know.

## Applying agent output

The result is JSON.

```json
{ "files": { "src/billing.ts": "<full new contents>" } }
```

`apimigrate agent-apply --results agent.json` then does this.

1. Stops when the evidence records that the gate of `apply` failed. See [after a failed apply](#after-a-failed-apply).
2. Checks that the working tree still matches the evidence from `apply`. If it does not, it stops.
3. Rejects any path that is not a file with a queued site, any non-string content, any file over 1 MB, and any path outside the scanned tree.
4. With `--typecheck`, type-checks the files the agent edited against the versions apply installed. An error the agent added on a line it changed is a gate finding. An error the original text already had before the install does not count, when `apply --typecheck` saved those errors in `base.json`. When the evidence records no install by apply, or a failed one, the check is skipped with a note. See [gate](gate.md#type-check).
5. Runs the gate, comparing the result to the original base snapshot, so deterministic and agent edits are judged together.
6. If the gate fails, writes nothing and exits 1.
7. Otherwise writes the files, runs `--test-cmd` if given, and updates the evidence with `agent`, `files`, `gate` and `tests`. `agent.typecheck` holds the type-check result, or null without `--typecheck`.

Use `--dry-run` to see the diffs and the gate result first.

## After a failed apply

When the gate of `apply` fails after the install and the tests, the rewrite is already on disk and the evidence records the findings. agent-apply then refuses to run, also with `--dry-run`. It prints apply's findings and exits 1, and writes nothing. Fix the findings, with a corrected rule or by hand, and run apply again.

The other choice was to carry apply's findings forward. It was not taken because agent-apply's gate result replaces apply's in the evidence, and agent-apply cannot redo all of apply's checks. It takes no coverage files, so coverage findings would be lost. A type error apply added in a file the agent did not edit could be kept as it is. In a file the agent edited, its line would have to be mapped through the agent's edit, and on a line the agent rewrote the error would be either dropped, though the agent may have kept it, or kept, though the agent may have fixed it. The agent can only edit files with queued sites, so it often cannot fix apply's findings at all.

## Limits

- The agent can only edit files that have queued sites. A fix that needs a change elsewhere has to be done by hand.
- Agent edits are not reproduced by `verify`. They are covered by the head digests, the gate and your tests.
- `--typecheck` assumes `node_modules` still holds what apply installed. It does not check that.
- The base snapshot is stored in `.apimigrate/base.json`, with the type errors of the original text before the install after `apply --typecheck`. It holds source text, so keep that directory out of version control. Add `.apimigrate/` to your `.gitignore`.

Related docs are [gate](gate.md), [evidence and replay](evidence.md) and [security](security.md).

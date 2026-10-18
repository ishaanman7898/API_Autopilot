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

1. Checks that the working tree still matches the evidence from `apply`. If it does not, it stops.
2. Rejects any path that is not a file with a queued site, any non-string content, any file over 1 MB, and any path outside the scanned tree.
3. Runs the gate, comparing the result to the original base snapshot, so deterministic and agent edits are judged together.
4. If the gate fails, writes nothing and exits 1.
5. Otherwise writes the files, runs `--test-cmd` if given, and updates the evidence with `agent`, `files`, `gate` and `tests`.

Use `--dry-run` to see the diffs and the gate result first.

## Limits

- The agent can only edit files that have queued sites. A fix that needs a change elsewhere has to be done by hand.
- Agent edits are not reproduced by `verify`. They are covered by the head digests, the gate and your tests.
- The base snapshot is stored in `.apimigrate/base.json`. It holds source text, so keep that directory out of version control. Add `.apimigrate/` to your `.gitignore`.

Related docs are [gate](gate.md), [evidence and replay](evidence.md) and [security](security.md).

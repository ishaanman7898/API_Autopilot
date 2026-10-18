# GitHub Action

`action.yml` is a composite action. It runs `apply` on your runner, uploads the evidence, and opens a draft pull request. It does not merge, enable auto merge, or approve.

## Inputs

| Input | Meaning |
| --- | --- |
| `rules` | Path to the signed rule file. Required. |
| `well-known` | Provider domain that serves the key set. Use this or `keys`. |
| `keys` | Path to a key set file committed in your repository. Use this or `well-known`. |
| `test-cmd` | Test command. A failure stops the run before any pull request is opened. |
| `token` | Token for pushing and opening the pull request. Defaults to the workflow token. |

## What it does

1. Installs the tool's dependencies with `npm ci --omit=dev --ignore-scripts`.
2. Runs `apply`. If the rule is unsigned, expired, pinned out, fails the gate, or fails your tests, the job fails and no pull request is opened.
3. Uploads `evidence.json`, `unresolved.json` and `audit.log` as an artifact.
4. If files changed, creates a branch named `apimigrate/<rule id>-<run id>`, stages only the files named in the evidence, commits, pushes, and runs `gh pr create --draft`.
5. The pull request body has a summary table, the unresolved sites, the verify command and the evidence bundle. Long evidence is truncated in the body and complete in the artifact.

If nothing changed, no branch or pull request is created.

## Permissions

The sample workflow in `examples/workflow.yml` asks for `contents: write` and `pull-requests: write`, and nothing else. Keep it that way. The tool needs no other access, and it never calls a merge API.

## Safety choices

- Inputs reach shell steps through environment variables, never through expression interpolation in the script.
- Branch names and titles are built from the evidence with unsafe characters replaced.
- Third party actions in the sample and CI workflows are pinned to full commit SHAs. Pin this action to a commit you have reviewed.
- The key source is explicit. Use `keys` with a committed file if you do not want to trust a fetch on every run.

## Limits

- The action has not been run on a real runner. The helper script, the pull request body and the no merge properties are covered by tests, the workflow itself is not.
- Pull requests created with the default workflow token do not trigger other workflows. Use a token with the access you want if you need that.
- A migration with unresolved sites opens a draft that is partly done. The body says so, and the sites are in the artifact.
- The repository must already be checked out, and Node 20 or newer must be set up before this action runs.

Related docs are [CLI reference](cli.md), [evidence and replay](evidence.md) and [security](security.md).

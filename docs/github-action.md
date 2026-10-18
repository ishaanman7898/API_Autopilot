# GitHub Action

`action.yml` is a composite action. In `apply` mode it runs one rule file on your runner, uploads the evidence, and opens a draft pull request. In `watch` mode it looks for new major versions on npm and opens one draft pull request per upgrade. It does not merge, enable auto merge, or approve.

## Inputs

| Input | Meaning |
| --- | --- |
| `mode` | `apply`, the default, or `watch`. |
| `rules` | Path to the signed rule file. Required in `apply` mode. |
| `well-known` | Provider domain that serves the key set. Use this or `keys`. |
| `keys` | Path to a key set file committed in your repository. Use this or `well-known`. |
| `test-cmd` | Test command. A failure stops the run before any pull request is opened. In `watch` mode it runs after each upgrade. |
| `token` | Token for pushing and opening the pull request. Defaults to the workflow token. |

## What it does

1. Installs the tool's dependencies with `npm ci --omit=dev --ignore-scripts`.
2. Runs `apply`. If the rule is unsigned, expired, pinned out, fails the gate, or fails your tests, the job fails and no pull request is opened.
3. Uploads `evidence.json`, `unresolved.json` and `audit.log` as an artifact.
4. If files changed, creates a branch named `apimigrate/<rule id>-<run id>`, stages only the files named in the evidence, commits, pushes, and runs `gh pr create --draft`.
5. The pull request body has a summary table, the unresolved sites, the verify command and the evidence bundle. Long evidence is truncated in the body and complete in the artifact.

If nothing changed, no branch or pull request is created.

## Watch mode

`examples/watch-workflow.yml` runs the action with `mode: watch` every week.

1. Runs `apimigrate watch` with the repository's `.apimigrate.yml`. It writes the plan and rule files to the runner's temp directory, not to the repository. See [CLI reference](cli.md#watch).
2. For each upgrade that has rules, starts a branch from the checked out commit and runs `apply`. Signed rules are checked against the key set they were verified with. Drafted rules run with `--allow-unsigned`. When `.apimigrate.yml` sets `pins`, drafts are skipped, since `pins` forbids unsigned rules.
3. If files changed, the gate and tests passed, and the branch does not already exist on the remote, it stages only the files named in the evidence, commits, pushes, and runs `gh pr create --draft`.
4. Uploads the plan, rule files, reports, evidence and pull request bodies as the `apimigrate-watch` artifact.

| Rules | Branch | Title |
| --- | --- | --- |
| Signed by the provider | `apimigrate/<package>-<from line>-to-<to line>` | `API migration: <package> <from> to <to>` |
| Drafted from the two releases | `apimigrate/<package>-<from line>-to-<to line>-unsigned` | `[unsigned draft] API migration: <package> <from> to <to>` |

An unsigned pull request starts with a warning saying the rules were drafted from `api.md` and nobody has reviewed or signed them, names the repository and ref of each release, and lists every drafted rule with its confidence and evidence. A signed one names the domain, key and URL its rules came from.

Branch names hold only the version lines, so a scheduled run skips an upgrade whose branch already exists, and a newer release on the same line does not open a second pull request. Delete the branch to get a fresh one. Signed rules published after a draft was opened get their own pull request. If `gh` fails after the push, the branch is deleted again so the next run retries. One upgrade that fails does not stop the others, but the job fails at the end.

## Permissions

The sample workflow in `examples/workflow.yml` asks for `contents: write` and `pull-requests: write`, and nothing else. Keep it that way. The tool needs no other access, and it never calls a merge API.

## Safety choices

- Inputs reach shell steps through environment variables, never through expression interpolation in the script.
- Branch names and titles are built from the evidence with unsafe characters replaced.
- Third party actions in the sample and CI workflows are pinned to full commit SHAs. Pin this action to a commit you have reviewed.
- The key source is explicit. Use `keys` with a committed file if you do not want to trust a fetch on every run.

## Limits

- The action runs on a real GitHub runner in the `action-selftest` workflow, in apply mode against a copy of `examples/app` and in watch mode against a repository that depends on Mux 14, with the real npm registry and GitHub. It pushes to a local bare repository and `gh` is replaced by a stand-in that records its arguments, so that run checks everything up to the pull request but does not open one.
- Pull requests created with the default workflow token do not trigger other workflows. Use a token with the access you want if you need that.
- A migration with unresolved sites opens a draft that is partly done. The body says so, and the sites are in the artifact.
- The repository must already be checked out, and Node 20 or newer must be set up before this action runs.

Related docs are [CLI reference](cli.md), [evidence and replay](evidence.md) and [security](security.md).

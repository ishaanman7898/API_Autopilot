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
| `install-cmd` | When a rule changes a `package.json`, the new versions are installed before the tests and the lockfile is updated, with the package manager the lockfile names and no install scripts. Set a command to run instead, or `none` to skip it. |
| `typecheck` | When the new versions are installed, `apply --typecheck` type-checks the changed files, and a type error the rewrite added on a line it changed fails the run. On by default. Set `false` to turn it off. It does nothing when `install-cmd` is `none`. See [gate](gate.md#type-check). |
| `token` | Token for pushing and opening the pull request. Defaults to the workflow token. |

## What it does

1. Installs the tool's dependencies with `npm ci --omit=dev --ignore-scripts`.
2. Runs `apply` with `--install`, so a changed `package.json` is installed, and its lockfile updated, before your tests run, and with `--typecheck`, so a rewrite that adds a type error fails the gate. If the rule is unsigned, expired, pinned out, fails the gate, fails to install, or fails your tests, the job fails and no pull request is opened.
3. Uploads `evidence.json`, `unresolved.json` and `audit.log` as an artifact.
4. If files changed, creates a branch named `apimigrate/<rule id>-<run id>`, stages only the files named in the evidence and the lockfiles the install updated, commits, pushes, and runs `gh pr create --draft`.
5. The pull request body has a summary table, the unresolved sites, the verify command and the evidence bundle. Long evidence is truncated in the body and complete in the artifact.

If nothing changed, no branch or pull request is created.

## Watch mode

`examples/watch-workflow.yml` runs the action with `mode: watch` every week.

1. Runs `apimigrate watch` with the repository's `.apimigrate.yml`. It writes the plan and rule files to the runner's temp directory, not to the repository. See [CLI reference](cli.md#watch).
2. For each upgrade that has rules, starts a branch from the checked out commit and runs `apply`, installing the new versions before your tests and type-checking the changed files as in apply mode. After an upgrade that installed, the base versions are installed again, so each upgrade is tested on its own. Signed rules are checked against the key set they were verified with. Drafted rules run with `--allow-unsigned`. When `.apimigrate.yml` sets `pins`, drafts are skipped, since `pins` forbids unsigned rules. When it sets `providers`, a draft is skipped unless its provider, the GitHub owner of the SDK, is listed.
3. If files changed, the install and gate passed, and the branch does not already exist on the remote, it stages only the files named in the evidence and the updated lockfiles, commits, pushes, and runs `gh pr create --draft`. When only your tests failed, the pull request still opens, marked as failing, so an upgrade that breaks your code is not the one you never hear about. A failed install or gate, including a type error the rewrite added, still stops it.
4. Uploads the plan, rule files, reports, evidence and pull request bodies as the `apimigrate-watch` artifact.

| Rules | Branch | Title |
| --- | --- | --- |
| Signed by the provider | `apimigrate/<package>-<from line>-to-<to line>` | `API migration: <package> <from> to <to>` |
| Drafted from the two releases | `apimigrate/<package>-<from line>-to-<to line>-unsigned` | `[unsigned draft] API migration: <package> <from> to <to>` |

A pull request whose tests failed has `[tests failing]` at the start of its title and a caution at the top of its body. The caution names the test command and its exit code, points to the unresolved call sites when there are any, and links the workflow run, whose log has the last lines of the test output. The output never goes in the pull request or the evidence.

An unsigned pull request starts with a warning saying the rules were drafted from `api.md`, or from the TypeScript declarations in the npm tarballs, and nobody has reviewed or signed them. It names the repository and ref of each release, or the version of each tarball, and lists every drafted rule with its confidence and evidence. A draft from declarations also lists the changes no rule can find, such as a removed subpath, the removals grouped without a rule each, such as static members, and, at the top, a removed default export with the import that replaces it and the rule that lists its imports under unresolved call sites. The rule table puts rules with call sites in the repository first. A signed one names the domain, key and URL its rules came from.

Branch names hold only the version lines, so a scheduled run skips an upgrade whose branch already exists, and a newer release on the same line does not open a second pull request. Delete the branch to get a fresh one. Signed rules published after a draft was opened get their own pull request. If `gh` fails after the push, the branch is deleted again so the next run retries. A pull request opened with failing tests does not fail the job. Any other upgrade that fails does not stop the others, but the job fails at the end.

## Permissions

The sample workflow in `examples/workflow.yml` asks for `contents: write` and `pull-requests: write`, and nothing else. Keep it that way. The tool needs no other access, and it never calls a merge API.

With the default workflow token, the repository must also allow workflows to open pull requests: in Settings, under Actions, General, Workflow permissions, turn on "Allow GitHub Actions to create and approve pull requests". It was off in a new personal repository, and an organization may have to allow it first. While it is off, the branch is pushed, `gh pr create` fails with `GitHub Actions is not permitted to create or approve pull requests`, the action deletes the branch again and the job fails. The setting also lets workflows approve pull requests, which the action never does. The other way is to pass a token in `token` that can push and open pull requests.

## Safety choices

- Inputs reach shell steps through environment variables, never through expression interpolation in the script.
- Branch names and titles are built from the evidence with unsafe characters replaced.
- Third party actions in the sample and CI workflows are pinned to full commit SHAs. Pin this action to a commit you have reviewed.
- The key source is explicit. Use `keys` with a committed file if you do not want to trust a fetch on every run.

## Limits

- The action runs on a real GitHub runner in the `action-selftest` workflow, in apply mode against a copy of `examples/app` and in watch mode against a repository that depends on Mux 14, with the real npm registry and GitHub. In watch mode its tests call the SDK, and a clone of the pushed branch must pass `npm ci` and `npm test`. It pushes to a local bare repository and `gh` is replaced by a stand-in that records its arguments, so that run checks everything up to the pull request but does not open one. The `provider-selftest` workflow runs watch mode the same way against a consumer that lists `atomicayush.github.io` in `sources`, so the signed path fetches a live rule index, key set and rule file.
- A real pull request was opened once, by hand, not in CI. A private throwaway repository held the same Mux 14 consumer, with no `.apimigrate.yml`, and a `workflow_dispatch` workflow that ran this action at commit `74be924` with `mode: watch`, `test-cmd: npm test` and the default token. The first run hit the repository setting described under Permissions, and the action deleted the branch it had pushed. After the setting was turned on, the next run opened a draft pull request as `github-actions[bot]`, titled `[unsigned draft] API migration: @mux/mux-node 14.1.1 to 15.5.0`. Its body had the unsigned warning, the five drafted rules, the lockfile note and `Tests | exit code 0`, and it changed only `package.json`, `package-lock.json` and `src/video.ts`. A third run skipped the upgrade because the branch existed. Nothing was merged, approved or set to auto merge.
- Pull requests created with the default workflow token do not trigger other workflows. Use a token with the access you want if you need that.
- A migration with unresolved sites opens a draft that is partly done. The body says so, and the sites are in the artifact.
- The repository must already be checked out, and Node 20 or newer must be set up before this action runs. Install your dependencies first, as the sample workflows do with `npm ci`, and set up `pnpm`, `yarn` or `bun` if the lockfile names one.
- A nested project whose `package.json` changed gets its own install only when it has its own lockfile or a workspace root lists it.

Related docs are [CLI reference](cli.md), [evidence and replay](evidence.md) and [security](security.md).

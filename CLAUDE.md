# Working in this repo

Rules for anyone, person or agent, who changes this repo. Start with `README.md` and `docs/architecture.md`. The current plan is in `docs/plan.md`.

## Git

- Commit straight to `main` and push after every change. Don't open branches or pull requests for our own work. Keep one logical change per commit.
- Run `git fetch` first and fast-forward only. If `origin/main` moved, rebase onto it. Never force-push.
- Run `node test/run.mjs` before each commit. Use the script, not a glob, because Node 20 doesn't expand `test/*.test.js`.
- Commit as yourself, with the configured git identity.
- If git has no stored GitHub credential, push through the GitHub CLI without changing your global config. Pushing files under `.github/workflows/` needs a token with the `workflow` scope.

```
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -q origin main
```

## No AI attribution

Never add Claude or Anthropic attribution anywhere. That means no `Co-Authored-By: Claude` trailers and no "Generated with Claude Code" lines. It also means no mentions in commit messages, pull request titles or bodies, branch names or code comments. Check with `git log -1 --format=%B` before you push.

## Several sessions in one checkout

- Stage only your own files. Never use `git add -A` or `git commit -a`.
- Before staging a file that another session also edits, read its diff and stage only your own changes.
- When others have uncommitted work, test on a clean copy. Run `git archive HEAD | tar -x -C <tmp>`, copy your changed files in, and symlink `node_modules`.

## Style

- Write dense code with sparse, plain comments, and match the code around it. Write plain docs with no marketing language.
- Only call something verified when a test or a real run showed it. Benchmarks publish their failures.

## Safety

- Ask first before anything outward-facing. That covers creating repos, publishing sites, opening pull requests on other people's repos, sending outreach and deleting things.
- Keep benchmark clones outside the repo, in `../bench-work`. Never run their install scripts; the harness uses `--ignore-scripts`.

## Gotchas

- `gh run list --commit` needs the full SHA. A short one silently finds nothing.
- In zsh, `$var` is not split into words, and an unmatched glob aborts the command.
- Windows checkouts can have CRLF line endings. Tests compare as LF.
- GitHub Actions can only open pull requests once the repository setting "Allow GitHub Actions to create and approve pull requests" is on.

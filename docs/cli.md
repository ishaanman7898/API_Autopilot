# CLI reference

Run `node bin/apimigrate.js <command>`, or `apimigrate <command>` once linked. Each command accepts `--help`. Flags are declared per command, so an unknown flag or a missing value is an error.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | Gate, test or verify failure, or an unexpected error. |
| 2 | Usage or config error, including an invalid rule file. |
| 3 | Trust failure. The rule is unsigned, tampered, expired, revoked, pinned out, not allowed, past its sunset, or its keys could not be fetched. |

## Commands

### keygen

`keygen [--out dir] [--key-id id] [--force]`

Writes `apimigrate-private.pem`, `apimigrate-public.pem` and `apimigrate-keys.json`, creating the `--out` folder if needed. Refuses to overwrite without `--force`. Publish the key set file at the well-known URL.

### lint

`lint <rules.json>`

Validates a rule file and lists anything that would block signing.

### sign

`sign <rules.json> --key private.pem [--key-id id] [--out file]`

Signs in place unless `--out` is given. Refuses files that are drafts or still carry `confidence` marks.

### check

`check <rules.json> (--keys file | --pubkey file.pem | --well-known domain) [--key-id id]`

Verifies the signature and the sunset date. Exactly one key source is required. The well-known fetch uses HTTPS only, does not follow redirects, times out after 10 seconds, and rejects bodies over 64 KB.

### draft

`draft <old> <new> [--provider p] [--package name] [--from v] [--to v] [--naming underscore|identity] [--out file]`

`<old>` and `<new>` are two OpenAPI 3.x JSON specs, or two SDK checkouts that contain `api.md`.

See [drafting rules](draft.md).

### apply

`apply --rules rules.json (--keys file | --pubkey file.pem | --well-known domain) [options]`

| Option | Effect |
| --- | --- |
| `--root dir` | Repository root. Defaults to the current directory. |
| `--dry-run` | Prints the changes as diffs and writes nothing, not even the audit log. |
| `--diff` | Prints diffs of the changes that were made. |
| `--test-cmd cmd` | Runs the command after applying. A non-zero exit fails the run. |
| `--cov-base file`, `--cov-head file` | Istanbul `coverage-summary.json` before and after. |
| `--strict` | Exit 1 if any call site is unresolved. |
| `--allow-unsigned` | Skips signature checks, prints a warning, and records `signed: false`. Refused when pins are set. |

The order of checks is rule validity, sunset, allowed provider, signature, pins. Every failure after validity exits with code 3 and writes nothing.

Files written to `.apimigrate/` are `evidence.json`, `unresolved.json`, `base.json` and `audit.log`. `base.json` holds source text, so keep this directory out of version control.

### agent-apply

`agent-apply --results agent.json [--root dir] [--test-cmd cmd] [--dry-run]`

See [agent fallback](agent.md).

### verify

`verify --rules rules.json --evidence evidence.json [--root baseDir] [--head headDir] [key options]`

See [evidence and replay](evidence.md).

### gate

`gate <baseDir> <headDir> [--cov-base file --cov-head file]`

Runs only the gate. Settings come from `.apimigrate.yml` in the base directory.

### watch

`watch [--root dir] [--out dir] [--registry url] [--dry-run]`

Reads every `package.json` in the repository and asks the npm registry, by default `https://registry.npmjs.org`, for each dependency's versions. A dependency is reported when its latest release is on a newer line than its range allows. A line is the major version, or `0.minor` below 1.0, where npm treats each minor as breaking. `from` is the newest release on the current line and `to` is the latest release. Ranges such as `*`, `latest`, `workspace:`, `file:`, git and URL dependencies are not followed. An `npm:` alias is checked under the package it points to. A deprecation message on the latest release is printed, since it often names a renamed package.

It writes `.apimigrate/watch/plan.json`, unless `--dry-run` is given. The `watch` setting limits it to the packages listed.

## Configuration

`.apimigrate.yml` in the repository root.

| Setting | Meaning |
| --- | --- |
| `providers` | Only rules from these providers may run. Empty means any. |
| `paths` | Files and directories to scan. Default is the repository root. They cannot leave it. |
| `extensions` | File extensions to scan. Default is `.js .jsx .ts .tsx .mjs .cjs .mts .cts`. Add `.json` and others when a `replace` rule targets them. |
| `pins` | Allowed rule hashes. When set, only these run, and `--allow-unsigned` is refused. |
| `protect` | Extra globs the gate treats as protected. |
| `allow` | Paths exempt from the protected file check. |
| `coverageTolerance` | Allowed drop in line coverage, in points. Default 0. |
| `draft` | Must be true or omitted. Pull requests are always drafts. |
| `watch` | Packages `watch` checks. Default every dependency. |
| `reviewers`, `model` | Accepted so a shared config file can carry them. The tool does not use them. |

Unknown settings, wrong types and malformed pins are errors with exit code 2.

Directories named `node_modules`, `.git`, `dist`, `build`, `coverage` and `.apimigrate` are skipped, symbolic links are not followed, and files over 2 MB are not scanned. A configured path that is a symbolic link, or is reached through one, is skipped and listed in the output. List items in `.apimigrate.yml` may be indented or sit at the same indent as their key. `tsconfig*.json` and `jsconfig*.json` files anywhere in the repository are also read, for path aliases. They are not scanned or edited. Every `package.json` in the repository is read with the scanned files, so `rename-dependency` rules can edit it. See [matching](matching.md).

Related docs are [rule format](rule-format.md), [gate](gate.md), [GitHub Action](github-action.md) and [security](security.md).

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

For a package listed in the `sources` setting, `watch` asks that package's domain for a signed rule file. It reads `https://<domain>/.well-known/apimigrate-rules.json`, finds the entry for the package with the same `from` and `to` lines, and fetches its `url`. The file is kept only when it is a valid rule file for that package, signed by a key in the same domain's `/.well-known/apimigrate-keys.json`, not past its sunset date, and allowed by `providers` and `pins`. Otherwise the plan records why. A kept file is written next to the plan as `<package>-<from>-to-<to>.rules.json`, with the key set it was checked against as `.keys.json`, so `check` and `apply` can use it with `--keys`. All fetches use HTTPS only and do not follow redirects.

```json
{ "rules": [{ "package": "acme-sdk", "from": "1", "to": "2", "url": "https://acme.com/rules/acme-sdk-1-to-2.json" }] }
```

When there are no usable signed rules, `watch` drafts rules from the two releases, as `draft` does from two SDK checkouts. It reads each release's `repository` and `gitHead` from npm and fetches its `api.md` files from `raw.githubusercontent.com`. It looks at the commit npm recorded, then the tags `v<version>`, `<version>`, `<name>-v<version>` and `<name>@<version>`. It follows the `repository.directory` of a monorepo, and redirects only within the same host. The draft is written as `<package>-<from>-to-<to>.draft.json` with its `.draft.report.json`. It keeps the `draft` mark and each rule's `confidence`, and it is not signed: `apply` runs it only with `--allow-unsigned`, which `pins` forbids. The `provider` is the GitHub owner. A new package name in the new release's `package.json` becomes a rename only when that name is published on npm at that version. Packages without `api.md`, npm aliases and repositories outside GitHub get no draft, and the plan says why.

Each plan entry has the package, the `from` and `to` releases, the `package.json` files and fields that name it, a `source` of `signed`, `draft` or `none`, and `signed`. For signed rules it has the rule and key files, the rule hash and the key id. For a draft it has the rule and report files, the rule counts, and the GitHub repository, ref and file count of each release. It has a `reason` when nothing was found, and `notes` when signed rules were looked for and a draft was used instead.

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
| `sources` | `"package domain"` pairs. `watch` looks for signed rules for that package at that domain. |
| `reviewers`, `model` | Accepted so a shared config file can carry them. The tool does not use them. |

Unknown settings, wrong types and malformed pins are errors with exit code 2.

Directories named `node_modules`, `.git`, `dist`, `build`, `coverage` and `.apimigrate` are skipped, symbolic links are not followed, and files over 2 MB are not scanned. A configured path that is a symbolic link, or is reached through one, is skipped and listed in the output. List items in `.apimigrate.yml` may be indented or sit at the same indent as their key. `tsconfig*.json` and `jsconfig*.json` files anywhere in the repository are also read, for path aliases. They are not scanned or edited. Every `package.json` in the repository is read with the scanned files, so `rename-dependency` rules can edit it. See [matching](matching.md).

Related docs are [rule format](rule-format.md), [gate](gate.md), [GitHub Action](github-action.md) and [security](security.md).

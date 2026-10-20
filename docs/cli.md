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

### index

`index <rules dir> --base-url https://acme.com/rules --keys apimigrate-keys.json [--out file]`

Builds the [rule index](rule-format.md#rule-index) that `watch` reads at `https://<domain>/.well-known/apimigrate-rules.json`. It reads every `*.json` file in the folder, except the `--keys` and `--out` files, and does not look in subfolders. Each file must be a valid rule file for one package, without draft or `confidence` marks, signed by a key in `--keys` that is valid now, and before its sunset date. `--keys` is the key set JSON the same domain publishes, since `watch` checks each file against that domain's keys.

The index takes the package from each file, and the lines from its `from` and `to`. `"1.x"`, `"14"`, `"^2.3.0"` and `"0.44.x"` give the lines `1`, `14`, `2` and `0.44`. A version that names no line, such as `"0.x"` or `"latest"`, is refused, and so is a `to` line that is not after the `from` line. Two files for the same package and lines are refused. Each `url` is `--base-url`, which must be https, followed by the file name, so upload the files under that URL with the names they have in the folder.

Entries are sorted by package, then by line, so the same files give the same index. It is printed, or written to `--out`. When any file is refused, the command names each file with its reason and writes nothing. It exits 3 when a refusal is about trust, such as an unsigned, badly signed or expired file, and 2 otherwise.

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
| `--install` | When a rule changed a `package.json`, installs the new versions before the tests, so they run against them, and updates the lockfile. Each changed `package.json` is installed in the closest folder with a lockfile, using the manager it names: `npm`, `pnpm`, `yarn` or `bun`, always without install scripts. With no lockfile it uses the workspace root that lists the package, or its own folder, and writes no lockfile. A failed install fails the run before the tests. |
| `--install-cmd cmd` | When a rule changed a `package.json`, runs this command at the root instead of `--install`. |
| `--test-cmd cmd` | Runs the command after applying, and after the install. A non-zero exit fails the run and prints the last 60 lines of its output. The output is not stored in the evidence. |
| `--typecheck` | Needs `--install` or `--install-cmd`. Type-checks each changed code file with the repository's own `tsconfig.json` or `jsconfig.json`: the original text before the install, and after the install and the tests the original text and the rewritten text. A type error on a line the rewrite changed that the original text does not have is a `type-error-added` gate finding, so the run fails. New errors on other lines are printed as notes. When nothing was installed, it is skipped with a note. See [gate](gate.md#type-check). |
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

For a package listed in the `sources` setting, `watch` asks that package's domain for a signed rule file. It reads `https://<domain>/.well-known/apimigrate-rules.json`, finds the entry for the package with the same `from` and `to` lines, and fetches its `url`. The file is kept only when it is a valid rule file for that package, signed by a key in the same domain's `/.well-known/apimigrate-keys.json`, not past its sunset date, and allowed by `providers` and `pins`. Otherwise the plan records why. A kept file is written next to the plan as `<package>-<from>-to-<to>.rules.json`, with the key set it was checked against as `.keys.json`, so `check` and `apply` can use it with `--keys`. All fetches use HTTPS only and do not follow redirects. Providers build the index with `index`.

```json
{ "rules": [{ "package": "acme-sdk", "from": "1", "to": "2", "url": "https://acme.com/rules/acme-sdk-1-to-2.json" }] }
```

When there are no usable signed rules, `watch` drafts rules from the two releases, as `draft` does from two SDK checkouts. It reads each release's `repository` and `gitHead` from npm and fetches its `api.md` files from `raw.githubusercontent.com`. It looks at the commit npm recorded, then the tags `v<version>`, `<version>`, `<name>-v<version>` and `<name>@<version>`. It follows the `repository.directory` of a monorepo, and redirects only within the same host. The draft is written as `<package>-<from>-to-<to>.draft.json` with its `.draft.report.json`. It keeps the `draft` mark and each rule's `confidence`, and it is not signed: `apply` runs it only with `--allow-unsigned`, which `pins` forbids. The `provider` is the GitHub owner. A new package name in the new release's `package.json` becomes a rename only when that name is published on npm at that version.

When neither release has an `api.md`, including releases that name no GitHub repository, `watch` drafts from the TypeScript declarations in the two npm tarballs instead. See [drafting rules](draft.md#from-typescript-declarations). Each tarball must be on the registry's host and match the sha512 `dist.integrity` of its registry manifest before anything in it is read. It is unpacked in memory, and only its `.d.ts`, `.d.mts`, `.d.cts` and `package.json` files are read. The caps are 32 MB for the tarball, 256 MB unpacked, and 5000 files and 48 MB read. An entry with an absolute path or a `..` segment rejects the tarball. Links are skipped. Nothing is installed, run or written to disk. The `provider` is the GitHub owner of either release, or else the npm scope or package name. When only one release has an `api.md`, or a release ships no declarations, there is no draft. npm aliases get no draft either. The plan says why.

Each plan entry has the package, the `from` and `to` releases, the `package.json` files and fields that name it, a `source` of `signed`, `draft` or `none`, and `signed`. For signed rules it has the rule and key files, the rule hash and the key id. For a draft it has the rule and report files, the rule counts, `draftedFrom` (`api.md` or `d.ts`), and in `upstream` the GitHub repository, ref and file count of each release, or for a `d.ts` draft the package, version, tarball URL, integrity and number of declaration files. A `d.ts` draft also has `uncovered`, the changes that no rule can find, such as a removed subpath, which the pull request lists under "Not covered by any rule", `grouped`, the removals listed in groups instead of getting a rule each, such as static members, and `defaultExportsRemoved` when a default export is gone, with the id of the rule that lists its imports. It has a `reason` when nothing was found, and `notes` when signed rules were looked for and a draft was used instead.

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

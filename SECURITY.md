# Security policy

## Threat model

API Autopilot reads signed rules from a publisher, rewrites code in a consumer's repository, and produces a pull request. The parties and what each is trusted to do are as follows.

| Party | Trusted to | Not trusted to |
| --- | --- | --- |
| Publisher | Say which changes migrate which calls, as long as their key is valid. | Be correct. A rule can be wrong, so output goes through a gate and review. |
| Consumer | Choose the key source, pins and settings. | Nothing. They own their repository. |
| Repository text | Nothing. Comments, strings, specs and changelogs are data. | Anything. They are treated as untrusted when they reach an agent. |
| Agent or person fixing queued sites | Nothing. Output goes through the same gate as deterministic edits. | Anything beyond the files with queued sites. |
| Network | Nothing. Key sets are fetched over HTTPS and checked. | Anything. |

The attacks this design is meant to resist are a forged or tampered rule, a replayed rule signed with a retired key, a hostile key server response, a rewrite that changes the wrong call, an agent that deletes or weakens tests, secrets added by a migration, prompt injection through repository text, and a pull request that cannot be checked. The controls are in [docs/security.md](docs/security.md).

Out of scope for v0 are a malicious publisher with a valid key, a compromised runner or repository, and a model with broad tool access that a consumer wires up themselves.

## Reporting an issue

Please report vulnerabilities privately through GitHub. On the repository page, open the Security tab and choose Report a vulnerability. Do not open a public issue for a vulnerability.

Include the version, the commands you ran, what you expected, and what happened. A rule file or repository that reproduces the problem helps. Reports are handled on a best effort basis by a small project. There is no bounty.

## Supported versions

Only the latest commit on `main` is supported.

## Known limits

The limits of version 0 are listed in the [README](README.md#limits-of-v0) and in each page of [docs](docs/). Reports about those limits are welcome as ordinary issues. Reports that show a limit leading to a silent unsafe rewrite, a bypassed gate, or a verification that passes when it should fail are treated as security issues.

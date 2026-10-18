# Contributing

## Setup

Node 20 or newer.

```sh
npm ci
npm test
```

The suite uses the built in Node test runner. It takes a few seconds. One test is skipped on systems that do not allow creating symbolic links.

## Ground rules

- Keep runtime dependencies at zero beyond the pinned `typescript`. If a change needs another one, open an issue first and explain which correctness risk it removes.
- Keep files small and modules separate. Parsing, matching, transforms, signing, evidence, gate and CLI each have their own files. Do not add layers that nothing uses.
- Fail closed. When a check cannot decide, the answer is to refuse or to queue the site.
- A call site the tool cannot prove must never be rewritten.
- Comments are short, one or two sentences, and only where the code does not explain itself.
- Docs are plain and direct. Use periods and commas. No emojis, no hype, and no claim the code does not back up. State limits.

## Tests

Every behavior change needs a test. Matching cases go in `test/fixtures/match-cases.js` with the input, the expected output and the expected unresolved sites. Trust, gate, evidence, agent, draft and CLI behavior each have a test file of their own in `test/`.

Before you open a pull request, run the full suite and say what you could not verify.

## Commits

One line messages that say what changed. No co-author or tool attribution lines.

## Pull requests

Describe what changed and why. Update the docs and the README limits if behavior or limits changed. Security issues go through [SECURITY.md](SECURITY.md), not a public pull request.

Related docs are [architecture](docs/architecture.md) and [SECURITY.md](SECURITY.md).

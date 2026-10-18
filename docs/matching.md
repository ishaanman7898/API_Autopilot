# Matching

The engine parses JavaScript and TypeScript with the TypeScript compiler, over an in-memory program of the scanned files. It asks the checker which declaration each name refers to, so scoping and shadowing are handled by the compiler and not by text patterns.

## The rule

A call site is rewritten only when its receiver is proven to come from the package. If a call looks like the rule but cannot be proven, it is never rewritten. It is written to `.apimigrate/unresolved.json` with a reason.

## What counts as proven

The engine traces the receiver of a call back to an export of the package. These forms are followed.

| Form | Example |
| --- | --- |
| Default import | `import Acme from 'acme-sdk'` |
| Named and aliased import | `import { Client as C } from 'acme-sdk'` |
| Namespace import | `import * as acme from 'acme-sdk'` |
| CommonJS require | `const Acme = require('acme-sdk')` |
| Destructured require | `const { Client } = require('acme-sdk')` |
| Dynamic import | `const m = await import('acme-sdk')` |
| Import equals | `import acme = require('acme-sdk')` |
| New instance | `const client = new Acme()` |
| Value from a package call | `const client = createClient()` where `createClient` comes from the package |
| Re-export | `export { default as Acme } from 'acme-sdk'`, then `import { Acme } from './barrel'` |
| Value exported from another scanned file | `export const client = new Acme()`, used in another file |
| CommonJS exports of another scanned file | `module.exports = { client }`, `exports.client = new Acme()` or `module.exports = new Acme()`, read with `require('./lib')` or `import` |
| Path alias to another scanned file | `import { client } from '@/lib/acme'`, with `"paths": { "@/*": ["./src/*"] }` in `tsconfig.json` |
| Factory function | `function getClient() { return new Acme() }`, then `getClient().charges.create()`. Also arrow and async functions, and factories that call other factories. |
| Lazily cached client | `let cached = null; function getClient() { if (!cached) cached = new Acme(); return cached }` |
| Client cached on the global object | `export const client = globalThis.__client ?? makeClient()`, with `globalThis.__client = client` in development, or the same through `const g = globalThis as unknown as {...}` |
| `??`, `\|\|` and `? :` | `cached ?? new Acme()`, when every side is the same value or `null` |
| Parentheses, `as`, `!`, `await` around any of the above | `(await import('acme-sdk')).default` |

A function call is proven when every `return` in the function gives the same package value, `null` or `undefined`. A `let` or `var` is proven when every value it is given anywhere in its file is the same package value, `null` or `undefined`. One assignment of anything else, or a write such as `+=`, `++`, a destructuring target or a loop variable, makes it unproven. Generators and methods are not followed.

A call whose receiver comes from a different package is ignored on purpose, even if its shape matches.

## Path aliases

Each file uses the `tsconfig.json` or `jsconfig.json` nearest to it, so a monorepo can have different aliases per package. The engine reads `compilerOptions.paths` and `baseUrl`, follows `extends` that point to a relative file, and in a solution-style config with only `references` it uses the first referenced config that declares aliases. The longest matching `paths` key wins, an exact key beats a wildcard, and `baseUrl` is tried after `paths`, as in TypeScript.

Config files are read from the whole repository, not only the scanned paths, and they are never edited. A bare specifier that does not resolve to a scanned file is treated as a different package. `extends` that names a package, such as `@tsconfig/next`, is not followed.

## What is rewritten

For `rename-method` with a dotted call, the last segments of the callee must be plain property accesses whose base is proven to be the package, a default export or an instance. The edit replaces only those segments and leaves the rest of the line alone.

For a single segment call such as `createCharge`, the edit renames the imported name and keeps the local name. `import { createCharge } from 'acme-sdk'` becomes `import { makeCharge as createCharge } from 'acme-sdk'`, and `const { createCharge } = require('acme-sdk')` becomes `const { makeCharge: createCharge } = require('acme-sdk')`. No reference changes.

For `rename-param`, the engine renames the key in an object literal argument. Shorthand `{ amount_cents }` becomes `{ amount: amount_cents }`. A quoted key keeps its quotes.

Edits are applied by source position, so formatting, comments and line endings outside the edit are untouched.

## What goes to the queue

| Reason | When |
| --- | --- |
| receiver of `<call>` cannot be traced to `<package>` | The call looks right and the file imports the package, directly or through other scanned files, but the receiver is a parameter, a class field, a `let` that is also given other values, the result of a function that can return something else, or anything else the engine cannot follow. |
| call path crosses a variable binding or a named import | The proven path is split across bindings, such as `const { charges } = client` and then `charges.create()`, or `import { charges } from 'acme-sdk'`. Rewriting the call alone would break the binding. |
| comments or optional chaining inside the call path | The text between the segments is not plain identifiers and dots. |
| argument N of `<call>` is not an object literal | The argument is a variable or an expression. |
| argument has spread or computed keys that may contain `<param>` | The literal might carry the key in a way the engine cannot see. |
| manual rule | The rule is `manual`, so every match is queued. |
| module name appears outside import syntax | A string equal to the module name, such as in `jest.mock`, is not touched. |
| module specifier uses escape sequences | The literal is not plain text. |

Files with syntax errors are skipped and listed. Files larger than 2 MB are not scanned. Both are reported in the run output.

## Limits

- No type information. The engine does not know the type of a parameter or a field.
- A call in a file that does not import the package, and does not reach it through a relative or aliased import of another scanned file, is not seen.
- Object methods and class members are not followed. A property of `globalThis` is followed only when every assignment to it in the scanned files gives the same package value, so code outside the scan that sets it is not seen.
- Files outside `paths` are not part of the program, so imports of them are not followed.
- `export * from` is not followed.
- Computed property names and dynamic calls are not followed.
- Test frameworks that mock the package can hide a call from the engine. The mock string is queued, the calls through the mock are not.
- The TypeScript version is pinned and recorded in the evidence. A different version may resolve some edge cases differently.

Related docs are [rule format](rule-format.md), [agent fallback](agent.md) and [security](security.md).

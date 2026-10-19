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
| Parameter typed with the SDK class | `function run(client: Acme)`, also `Acme \| null` and `acme.Client` |
| Class field through `this` | `private readonly client: Acme`, `constructor(private client: Acme)` or `private readonly client = new Acme()`, used as `this.client` |
| Method of a local class | `client() { return new Acme() }`, then `this.client().charges.create()`, `new Svc().client()`, or `svc.client()` with `svc: Svc`. Also static methods and methods of a local base class. |
| Getter | `get client() { return (this.cached ??= new Acme()) }`, in a class or an object literal |
| Object literal property or method | `const api = { client: new Acme(), cf() { return cf } }`, then `api.client` or `api.cf()`, also from another file and through `this` in the literal's own methods |
| Callback a local method calls | `runner.run(async ({ cf }) => cf.zones.list())`, when `run(fn)` only ever calls `fn` with the same value, such as `fn(await this.getClient())` |
| Untyped parameter of a local function | `function zone(cf) {...}` when every call in the file passes the same package value, and the function is not exported, passed on or bound |
| Client cached on the global object | `export const client = globalThis.__client ?? makeClient()`, with `globalThis.__client = client` in development, or the same through `const g = globalThis as unknown as {...}` |
| `??`, `\|\|` and `? :` | `cached ?? new Acme()`, when every side is the same value or `null` |
| Name in a type | `Acme.Jobs.Job`, `typeof client.jobs`, `import Jobs = Acme.Jobs` or `import('acme-sdk').Jobs.Job`, also inside JSDoc types, each traced from its first name like a receiver |
| Parentheses, `as`, `!`, `await` around any of the above | `(await import('acme-sdk')).default` |

A function call is proven when every `return` in the function gives the same package value, `null` or `undefined`. A `let` or `var` is proven when every value it is given anywhere in its file is the same package value, `null` or `undefined`. One assignment of anything else, or a write such as `+=`, `++`, a destructuring target or a loop variable, makes it unproven. Generators are not followed.

A method or getter is followed through its `return`s like a function, and an object literal's property through its value. A class field still needs a type annotation, or `readonly` with an initializer. A member is not followed, and its calls are queued, when:

- a property with its name is written anywhere in the scanned files, as in `svc.client = mock`, `Svc.prototype.client = ...` or `this.client = this.client.bind(this)`. A write through `this` in an unrelated class, such as another class setting its own field of the same name, does not count.
- the class is known only from a type or from `this`, and a subclass in the scanned files declares the same member, or the class is passed to a mixin, as in `class B extends Mixin(A)`. This also applies to a `readonly` field traced through its initializer.
- the object literal is held in a variable or a default export, and any scanned file uses it other than to read its properties, export it or name its type. `register(api)`, `const other = api` and `{ api }` let other code change it. A spread or computed key after the member can also replace it.

An untyped parameter of a function passed straight to a local function or method is followed when every call that function makes to the parameter passes the same value. It is queued when the function passes the callback on, stores it, reads `arguments` or calls it with anything else.

A call whose receiver comes from a different package is ignored on purpose, even if its shape matches.

## Call paths

A rule names a call by its path from the package, whatever the local names. `client.charges.create()`, `Acme.charges.create()` and `new Acme().charges.create()` are all `charges.create`, and a name imported by name starts the path, so `charges.create()` after `import { charges } from 'acme-sdk'` is `charges.create` too. Constructor calls are matched only by a path that starts with `new `. `new Client` matches `new Client()` after `import { Client } from 'acme-sdk'`, and `new acme.Client()`. `new default` matches the default export, after `import Acme from 'acme-sdk'`, `import { default as Acme } from 'acme-sdk'` or `const Acme = require('acme-sdk')`. `default` alone matches calls of the default export itself, such as `make({ verbose: true })` after `import make from 'acme-sdk'`. Only `rename-option` and `manual` rules take these paths.

## Path aliases

Each file uses the `tsconfig.json` or `jsconfig.json` nearest to it, so a monorepo can have different aliases per package. The engine reads `compilerOptions.paths` and `baseUrl`, follows `extends` that point to a relative file, and in a solution-style config with only `references` it uses the first referenced config that declares aliases. The longest matching `paths` key wins, an exact key beats a wildcard, and `baseUrl` is tried after `paths`, as in TypeScript.

Config files are read from the whole repository, not only the scanned paths, and they are never edited. A bare specifier that does not resolve to a scanned file is treated as a different package. `extends` that names a package, such as `@tsconfig/next`, is not followed.

## What is rewritten

For `rename-method` with a dotted call, the last segments of the callee must be plain property accesses whose base is proven to be the package, a default export or an instance. The edit replaces only those segments and leaves the rest of the line alone.

For a single segment call such as `createCharge`, the edit renames the imported name and keeps the local name. `import { createCharge } from 'acme-sdk'` becomes `import { makeCharge as createCharge } from 'acme-sdk'`, and `const { createCharge } = require('acme-sdk')` becomes `const { makeCharge: createCharge } = require('acme-sdk')`. No reference changes.

For `rename-param`, the engine renames the key in an object literal argument. Shorthand `{ amount_cents }` becomes `{ amount: amount_cents }`. A quoted key keeps its quotes.

For `rename-option`, the engine renames a key of the object literal passed as argument `match.arg`. `z.string().min(2, { message })` becomes `z.string().min(2, { error: message })`, and `new Acme({ 'baseUrl': url })` becomes `new Acme({ 'baseURL': url })`. Parentheses, `as` and `satisfies` around the object are kept. A literal such as a string or number, a template, an array, `null` or `undefined` in that position cannot hold the key and is left alone, as is an object without the key or one already migrated. Anything else is queued, and nothing in that call is changed: a variable or other expression, a spread or computed key, the key as a getter, setter or method, or an object that has both keys. A call that cannot be traced is queued only when its argument would have been renamed or queued, so `Math.min(a, 0)` is not queued for a rule on `min` with `arg: 1`, and `Math.min(a, b)` is.

For `rename-namespace`, the path is renamed wherever it directly follows a proven package value: in calls and reads such as `client.robotsPreview.jobs.list()`, and in type names. With `import Mux from '@mux/mux-node'`, a rule from `RobotsPreview` to `Robots` turns `Mux.RobotsPreview.JobStatus` into `Mux.Robots.JobStatus`, and the same in `class Jobs extends Mux.RobotsPreview`, `import Alias = Mux.RobotsPreview`, `import('@mux/mux-node/resources/robots-preview').RobotsPreview` and JSDoc types such as `@type {Mux.RobotsPreview.JobStatus}`. A rule names one spelling, so when both the property `robotsPreview` and the type namespace `RobotsPreview` change, as in Mux 15, each needs its own rule. A one-segment path that is imported by name from the package, or destructured from a proven value, is renamed with the local name kept: `import type { RobotsPreview } from '...'` becomes `import type { Robots as RobotsPreview } from '...'`, and no reference changes. A type the scanned files declare themselves, such as a local namespace with a member of the same name, is left alone. So is a JSDoc `@link`.

Edits are applied by source position, so formatting, comments and line endings outside the edit are untouched.

## What goes to the queue

| Reason | When |
| --- | --- |
| receiver of `<call>` cannot be traced to `<package>` | The call looks right and the file imports the package, directly or through other scanned files, but the receiver is a parameter, a class field, a `let` that is also given other values, the result of a function that can return something else, a member that is written elsewhere or may be overridden, or anything else the engine cannot follow. |
| type name `<path>` cannot be traced to `<package>` | The same for a type, such as `typeof x.robotsPreview`, where `x` cannot be followed. |
| type name `<path>` follows `<name>`, which is imported by name from `<package>` and may not be the client | A type such as `Mux.RobotsPreview.JobStatus` after `import { Mux } from '@mux/mux-node'`. A named export can be anything, so the path after it is not proven to be the client's. |
| call path crosses a variable binding or a named import | The proven path is split across bindings, such as `const { charges } = client` and then `charges.create()`, or `import { charges } from 'acme-sdk'`. Rewriting the call alone would break the binding. |
| comments or optional chaining inside the call path | The text between the segments is not plain identifiers and dots. |
| argument N of `<call>` is not an object literal | The argument is a variable or an expression. |
| argument has spread or computed keys that may contain `<param>` | The literal might carry the key in a way the engine cannot see. |
| argument N of `<call>` spreads an object that may hold `<key>`, or has a computed key that may be `<key>` | The same for `rename-option`, which queues these even when the literal also has the key, since a spread after it could override the old key. |
| argument N of `<call>` already has `<to>` | The object has both the old key and the new one, so a person decides which value stays. |
| `<key>` in argument N of `<call>` is a method or accessor | The key is a getter, setter or method, not a plain property. |
| `new <Name>` uses the default export of `<package>`, which may not be `<Name>` | A constructor call traced to another export of the package, such as `new Client()` after `import Client from 'acme-sdk'` for a rule on `new Client`. The engine cannot tell whether the two are the same class. A `new default` rule that runs first moves these calls. |
| manual rule | The rule is `manual`, so every match is queued. A rule with `match.import: "default"` matches the imports of the package's default export instead of calls, and its sites are queued as `manual rule: default import needs a migration`. |
| module name appears outside import syntax | A string equal to the module name, such as in `jest.mock`, is not touched. |
| module specifier uses escape sequences | The literal is not plain text. |

Files with syntax errors are skipped and listed. Files larger than 2 MB are not scanned. Both are reported in the run output.

## Limits

- No type information. The engine does not know the type of a parameter or a field.
- A call in a file that does not import the package, and does not reach it through a relative or aliased import of another scanned file, is not seen.
- A class instance is not checked for escapes, so a method replaced other than by assignment, as by `Object.assign(svc, ...)` or a test spy, is not seen. An object literal that no variable holds, such as one a method returns, is only checked for writes to the member. A property of `globalThis` is followed only when every assignment to it in the scanned files gives the same package value, so code outside the scan that sets it is not seen.
- Files outside `paths` are not part of the program, so imports of them are not followed.
- `export * from` is not followed.
- Computed property names and dynamic calls are not followed. Neither are indexed access types such as `Mux['RobotsPreview']`.
- Test frameworks that mock the package can hide a call from the engine. The mock string is queued, the calls through the mock are not.
- The TypeScript version is pinned and recorded in the evidence. A different version may resolve some edge cases differently.

Related docs are [rule format](rule-format.md), [agent fallback](agent.md) and [security](security.md).

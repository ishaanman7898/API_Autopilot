const base = { schema: 'apimigrate/1', provider: 'acme', package: 'acme-sdk', id: 'acme', from: '1', to: '2', sunset: '2099-01-01' };
const method = { id: 'm', kind: 'rename-method', match: { call: 'charges.create' }, transform: { to: 'payments.create' } };
const param = { id: 'p', kind: 'rename-param', match: { call: 'payments.create', param: 'amount_cents' }, transform: { to: 'amount' } };
const mp = [method, param];

// expect: files that must equal the given text. unresolved: [file, line, reason substring]. untouched: files that must not change.
export const cases = [
  {
    name: 'default import and new instance',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nc.charges.create({ amount_cents: 1 });\n" },
    expect: { 'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nc.payments.create({ amount: 1 });\n" },
    unresolved: [],
  },
  {
    name: 'aliased named import',
    rules: mp,
    files: { 'a.ts': "import { Client as C } from 'acme-sdk';\nconst c = new C();\nawait c.charges.create({ amount_cents: 1 });\n" },
    expect: { 'a.ts': "import { Client as C } from 'acme-sdk';\nconst c = new C();\nawait c.payments.create({ amount: 1 });\n" },
    unresolved: [],
  },
  {
    name: 'namespace import',
    rules: mp,
    files: { 'a.ts': "import * as acme from 'acme-sdk';\nconst c = new acme.Client();\nc.charges.create({ amount_cents: 1 });\n" },
    expect: { 'a.ts': "import * as acme from 'acme-sdk';\nconst c = new acme.Client();\nc.payments.create({ amount: 1 });\n" },
    unresolved: [],
  },
  {
    name: 'require and destructured require',
    rules: mp,
    files: {
      'a.js': "const Acme = require('acme-sdk');\nconst c = new Acme();\nc.charges.create({ amount_cents: 1 });\n",
      'b.js': "const { Client } = require('acme-sdk');\nconst c = new Client();\nc.charges.create({ amount_cents: 2 });\n",
    },
    expect: {
      'a.js': "const Acme = require('acme-sdk');\nconst c = new Acme();\nc.payments.create({ amount: 1 });\n",
      'b.js': "const { Client } = require('acme-sdk');\nconst c = new Client();\nc.payments.create({ amount: 2 });\n",
    },
    unresolved: [],
  },
  {
    name: 'named import of a sub object needs the agent',
    rules: mp,
    files: { 'a.ts': "import { charges } from 'acme-sdk';\ncharges.create({ amount_cents: 1 });\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [['a.ts', 2, 'crosses a variable binding']],
  },
  {
    name: 'destructured from an instance needs the agent',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nconst { charges } = c;\ncharges.create({ amount_cents: 1 });\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [['a.ts', 4, 'crosses a variable binding']],
  },
  {
    name: 'parameter receiver cannot be proven',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nexport function f(client: Acme) {\n  return client.charges.create({ amount_cents: 1 });\n}\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [['a.ts', 3, 'cannot be traced']],
  },
  {
    name: 'shadowed identifier is never rewritten',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nexport function g() {\n  const Acme = { charges: { create(x: unknown) { return x; } } };\n  return Acme.charges.create({ amount_cents: 1 });\n}\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [['a.ts', 4, 'cannot be traced']],
  },
  {
    name: 'a different library with the same shape is ignored',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nimport other from 'other-sdk';\nconst o = new other();\no.charges.create({ amount_cents: 1 });\nexport { Acme };\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [],
  },
  {
    name: 'lookalike in a file that never imports the package is ignored',
    rules: mp,
    files: { 'a.ts': 'declare const c: any;\nc.charges.create({ amount_cents: 1 });\n' },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [],
  },
  {
    name: 'instance exported from another file',
    rules: mp,
    files: {
      'client.ts': "import Acme from 'acme-sdk';\nexport const client = new Acme();\n",
      'app.ts': "import { client } from './client';\nclient.charges.create({ amount_cents: 1 });\n",
    },
    expect: { 'app.ts': "import { client } from './client';\nclient.payments.create({ amount: 1 });\n" },
    untouched: ['client.ts'],
    unresolved: [],
  },
  {
    name: 're-export barrel',
    rules: mp,
    files: {
      'barrel.ts': "export { default as Acme } from 'acme-sdk';\n",
      'app.ts': "import { Acme } from './barrel';\nconst c = new Acme();\nc.charges.create({ amount_cents: 1 });\n",
    },
    expect: { 'app.ts': "import { Acme } from './barrel';\nconst c = new Acme();\nc.payments.create({ amount: 1 });\n" },
    untouched: ['barrel.ts'],
    unresolved: [],
  },
  {
    name: 'strings and comments are never edited',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nconst s = 'c.charges.create({ amount_cents: 1 })';\n// c.charges.create({ amount_cents: 1 })\nc.charges.create({ amount_cents: 1 });\n" },
    expect: { 'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nconst s = 'c.charges.create({ amount_cents: 1 })';\n// c.charges.create({ amount_cents: 1 })\nc.payments.create({ amount: 1 });\n" },
    unresolved: [],
  },
  {
    name: 'param forms: shorthand, quoted key, variable argument, spread',
    rules: mp,
    files: {
      'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nconst amount_cents = 1;\nc.charges.create({ amount_cents, currency: 'usd' });\nc.charges.create({ 'amount_cents': 2 });\nconst args = { amount_cents: 3 };\nc.charges.create(args);\nc.charges.create({ ...args, currency: 'usd' });\n",
    },
    expect: {
      'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nconst amount_cents = 1;\nc.payments.create({ amount: amount_cents, currency: 'usd' });\nc.payments.create({ 'amount': 2 });\nconst args = { amount_cents: 3 };\nc.payments.create(args);\nc.payments.create({ ...args, currency: 'usd' });\n",
    },
    unresolved: [['a.ts', 7, 'not an object literal'], ['a.ts', 8, 'spread or computed']],
  },
  {
    name: 'optional chaining in the call path needs the agent',
    rules: [method],
    files: { 'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nc.charges?.create({});\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [['a.ts', 3, 'optional chaining']],
  },
  {
    name: 'rename-import covers every import form and flags strings outside import syntax',
    rules: [{ id: 'i', kind: 'rename-import', match: { module: 'acme-sdk' }, transform: { to: '@acme/sdk' } }],
    files: {
      'a.ts': "import A from 'acme-sdk';\nimport { E } from 'acme-sdk/errors';\nexport * from 'acme-sdk/types';\nconst r = require('acme-sdk');\nconst d = await import('acme-sdk');\njest.mock('acme-sdk');\n",
    },
    expect: {
      'a.ts': "import A from '@acme/sdk';\nimport { E } from '@acme/sdk/errors';\nexport * from '@acme/sdk/types';\nconst r = require('@acme/sdk');\nconst d = await import('@acme/sdk');\njest.mock('acme-sdk');\n",
    },
    unresolved: [['a.ts', 6, 'outside import syntax']],
  },
  {
    name: 'top level function rename keeps local names',
    rules: [{ id: 'f', kind: 'rename-method', match: { call: 'createCharge' }, transform: { to: 'makeCharge' } }],
    files: {
      'a.ts': "import { createCharge } from 'acme-sdk';\ncreateCharge();\n",
      'b.ts': "import { createCharge as cc } from 'acme-sdk';\ncc();\n",
      'c.js': "const { createCharge } = require('acme-sdk');\ncreateCharge();\n",
    },
    expect: {
      'a.ts': "import { makeCharge as createCharge } from 'acme-sdk';\ncreateCharge();\n",
      'b.ts': "import { makeCharge as cc } from 'acme-sdk';\ncc();\n",
      'c.js': "const { makeCharge: createCharge } = require('acme-sdk');\ncreateCharge();\n",
    },
    unresolved: [],
  },
  {
    name: 'files with syntax errors are skipped, not guessed at',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nconst c = new Acme(;\nc.charges.create({ amount_cents: 1 });\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [],
    skipped: ['a.ts'],
  },
  {
    name: 'let bindings that can be reassigned are not trusted',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nlet c = new Acme();\nc.charges.create({ amount_cents: 1 });\n" },
    expect: {},
    untouched: ['a.ts'],
    unresolved: [['a.ts', 3, 'cannot be traced']],
  },
];

export const ruleSet = (rules, extra = {}) => ({ ...base, rules, ...extra });

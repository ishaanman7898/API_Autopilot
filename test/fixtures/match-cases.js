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
  {
    name: 'a binding exported as the default is followed',
    rules: mp,
    files: {
      'lib/c.ts': "import Acme from 'acme-sdk';\nconst c = new Acme();\nexport default c;\n",
      'lib/d.ts': "import Acme from 'acme-sdk';\nconst d = new Acme();\nexport { d as default };\n",
      'a.ts': "import c from './lib/c';\nimport d from './lib/d';\nc.charges.create({ amount_cents: 1 });\nd.charges.create({ amount_cents: 2 });\n",
    },
    expect: { 'a.ts': "import c from './lib/c';\nimport d from './lib/d';\nc.payments.create({ amount: 1 });\nd.payments.create({ amount: 2 });\n" },
    unresolved: [],
  },
  ...aliasCases(),
];

// Path aliases from tsconfig.json and jsconfig.json. configs are passed to the engine beside the files.
function aliasCases() {
  const client = "import Acme from 'acme-sdk';\nexport const client = new Acme();\n";
  const use = (spec) => `import { client } from '${spec}';\nclient.charges.create({ amount_cents: 1 });\n`;
  const used = (spec) => `import { client } from '${spec}';\nclient.payments.create({ amount: 1 });\n`;
  return [
    {
      name: 'tsconfig paths alias with baseUrl',
      rules: mp,
      configs: { 'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }' },
      files: { 'src/lib/client.ts': client, 'src/app/route.ts': use('@/lib/client') },
      expect: { 'src/app/route.ts': used('@/lib/client') },
      unresolved: [],
    },
    {
      name: 'paths without baseUrl, comments and trailing commas, a default export and a .js extension',
      rules: mp,
      configs: { 'tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "paths": { "~lib/*": ["lib/*"], }, },\n}\n' },
      files: {
        'lib/acme.ts': "import Acme from 'acme-sdk';\nexport default new Acme();\n",
        'app.ts': "import acme from '~lib/acme.js';\nacme.charges.create({ amount_cents: 1 });\n",
      },
      expect: { 'app.ts': "import acme from '~lib/acme.js';\nacme.payments.create({ amount: 1 });\n" },
      unresolved: [],
    },
    {
      name: 'baseUrl alone resolves bare imports and an exact paths key wins',
      rules: mp,
      configs: { 'tsconfig.json': '{ "compilerOptions": { "baseUrl": "src", "paths": { "acme-client": ["services/acme.ts"], "acme-*": ["nowhere/*"] } } }' },
      files: { 'src/services/acme.ts': client, 'src/page.ts': use('services/acme'), 'src/exact.ts': use('acme-client') },
      expect: { 'src/page.ts': used('services/acme'), 'src/exact.ts': used('acme-client') },
      unresolved: [],
    },
    {
      name: 'monorepo: each file uses its nearest config, following extends',
      rules: mp,
      configs: {
        'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["packages/shared/*"] } } }',
        'packages/web/tsconfig.json': '{ "extends": "../../tsconfig.base" }',
        'packages/api/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      },
      files: {
        'packages/shared/acme.ts': client,
        'packages/web/a.ts': use('@shared/acme'),
        'packages/web/c.ts': use('@/client'),
        'packages/api/src/client.ts': client,
        'packages/api/b.ts': use('@/client'),
      },
      expect: { 'packages/web/a.ts': used('@shared/acme'), 'packages/api/b.ts': used('@/client') },
      untouched: ['packages/web/c.ts'],
      unresolved: [],
    },
    {
      name: 'jsconfig alias in a JavaScript project',
      rules: mp,
      configs: { 'jsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["*"] } } }' },
      files: { 'lib/acme.js': client, 'pages/api.js': use('@/lib/acme') },
      expect: { 'pages/api.js': used('@/lib/acme') },
      unresolved: [],
    },
    {
      name: 'solution style tsconfig keeps its aliases in a referenced config',
      rules: mp,
      configs: {
        'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.app.json" }] }',
        'tsconfig.node.json': '{ "compilerOptions": { "composite": true } }',
        'tsconfig.app.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
      },
      files: { 'src/client.ts': client, 'src/main.ts': use('@/client') },
      expect: { 'src/main.ts': used('@/client') },
      unresolved: [],
    },
    {
      name: 'an alias that resolves to no scanned file is treated as another package',
      rules: mp,
      configs: { 'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }' },
      files: { 'a.ts': "import Acme from 'acme-sdk';\nimport { client } from '@/missing';\nnew Acme();\nclient.charges.create({ amount_cents: 1 });\n" },
      expect: {},
      untouched: ['a.ts'],
      unresolved: [],
    },
    {
      name: 'without the config the same alias is not followed',
      rules: mp,
      files: { 'src/lib/client.ts': client, 'src/app/route.ts': use('@/lib/client') },
      expect: {},
      untouched: ['src/app/route.ts'],
      unresolved: [],
    },
  ];
}

export const ruleSet = (rules, extra = {}) => ({ ...base, rules, ...extra });

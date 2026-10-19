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
    name: 'an untyped parameter of an exported function cannot be proven',
    rules: mp,
    files: { 'a.ts': "import Acme from 'acme-sdk';\nexport function f(client) {\n  return client.charges.create({ amount_cents: 1 });\n}\n" },
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
    name: 'rename-import covers JSDoc import() types and leaves plain comments alone',
    rules: [{ id: 'i', kind: 'rename-import', match: { module: 'acme-sdk' }, transform: { to: '@acme/sdk' } }],
    files: {
      'a.js': "/**\n * @param {import(\"acme-sdk/resources/jobs\").Job} job\n * @returns {Promise<import('acme-sdk').Client>}\n */\nexport async function run(job) {}\n// acme-sdk is loaded lazily, see import(\"acme-sdk\") in docs\n",
      'b.ts': "/** @type {import('acme-sdk').Client} */\nexport const c = null;\nimport type { Job } from 'acme-sdk/jobs';\n",
    },
    expect: {
      'a.js': "/**\n * @param {import(\"@acme/sdk/resources/jobs\").Job} job\n * @returns {Promise<import('@acme/sdk').Client>}\n */\nexport async function run(job) {}\n// acme-sdk is loaded lazily, see import(\"acme-sdk\") in docs\n",
      'b.ts': "/** @type {import('@acme/sdk').Client} */\nexport const c = null;\nimport type { Job } from '@acme/sdk/jobs';\n",
    },
    unresolved: [],
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
    name: 'let bindings reassigned to something else are not trusted',
    rules: mp,
    files: {
      'a.ts': "import Acme from 'acme-sdk';\nlet c = new Acme();\nif (process.env.MOCK) c = makeMock();\nc.charges.create({ amount_cents: 1 });\n",
      'b.ts': "import Acme from 'acme-sdk';\nlet d = new Acme();\nfor (d of clients) {}\nd.charges.create({ amount_cents: 2 });\n",
      'c.ts': "import Acme from 'acme-sdk';\nlet e = new Acme();\n[e] = list;\ne.charges.create({ amount_cents: 3 });\n",
    },
    expect: {},
    untouched: ['a.ts', 'b.ts', 'c.ts'],
    unresolved: [['a.ts', 4, 'cannot be traced'], ['b.ts', 4, 'cannot be traced'], ['c.ts', 4, 'cannot be traced']],
  },
  ...factoryCases(),
  ...commonJsCases(),
  ...namespaceCases(),
  ...typeNameCases(),
  ...globalCacheCases(),
  ...positionalCases(),
  ...optionCases(),
  ...parameterCases(),
  {
    name: 'lookalikes in files that reach the package through local imports are queued, others are not',
    rules: mp,
    files: {
      'lib/acme.ts': "import Acme from 'acme-sdk';\nconst g = globalThis as any;\nexport const client = g.acme ?? new Acme();\n",
      'route.ts': "import { client } from './lib/acme';\nexport const pay = () => client.charges.create({ amount_cents: 1 });\n",
      'page.ts': "import { pay } from './route';\npay();\nwindow.acme.charges.create({ amount_cents: 2 });\n",
      'util.ts': 'export const noop = () => {};\n',
      'other.ts': "import { noop } from './util';\nnoop();\nsomething.charges.create({ amount_cents: 3 });\n",
    },
    expect: {},
    untouched: ['route.ts', 'page.ts', 'other.ts'],
    unresolved: [['route.ts', 2, 'cannot be traced'], ['page.ts', 3, 'cannot be traced']],
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
  ...defaultImportCases(),
];

// Clients passed in as parameters: typed with the SDK class, or untyped in a local helper.
function parameterCases() {
  const imp = "import Acme from 'acme-sdk';\n";
  const call = (r) => `${r}.charges.create({ amount_cents: 1 });`;
  const done = (r) => `${r}.payments.create({ amount: 1 });`;
  return [
    {
      name: 'a parameter typed with the SDK class is followed',
      rules: mp,
      files: {
        'a.ts': `${imp}import * as acme from 'acme-sdk';\nimport type { Client } from 'acme-sdk';\nexport function a(client: Acme) { ${call('client')} }\nexport function b(client: Acme | null) { ${call('client!')} }\nexport function c(client: acme.Client) { ${call('client')} }\nclass S { run(client: Client) { ${call('client')} } }\nexport function d(client: Map<string, Acme>) { ${call('client')} }\n`,
      },
      expect: {
        'a.ts': `${imp}import * as acme from 'acme-sdk';\nimport type { Client } from 'acme-sdk';\nexport function a(client: Acme) { ${done('client')} }\nexport function b(client: Acme | null) { ${done('client!')} }\nexport function c(client: acme.Client) { ${done('client')} }\nclass S { run(client: Client) { ${done('client')} } }\nexport function d(client: Map<string, Acme>) { ${call('client')} }\n`,
      },
      unresolved: [['a.ts', 8, 'cannot be traced']],
    },
    {
      name: 'class fields and constructor parameter properties are followed through this',
      rules: mp,
      files: {
        'a.ts': `${imp}export class A {\n  private readonly client: Acme;\n  constructor() { this.client = new Acme(); }\n  pay() { ${call('this.client')} }\n}\nexport class B {\n  constructor(private readonly client: Acme) {}\n  pay() { ${call('this.client')} }\n}\nexport class C {\n  private readonly client = new Acme();\n  pay() { ${call('this.client')} }\n}\nexport class D {\n  private client = new Acme();\n  pay() { ${call('this.client')} }\n}\n`,
      },
      expect: {
        'a.ts': `${imp}export class A {\n  private readonly client: Acme;\n  constructor() { this.client = new Acme(); }\n  pay() { ${done('this.client')} }\n}\nexport class B {\n  constructor(private readonly client: Acme) {}\n  pay() { ${done('this.client')} }\n}\nexport class C {\n  private readonly client = new Acme();\n  pay() { ${done('this.client')} }\n}\nexport class D {\n  private client = new Acme();\n  pay() { ${call('this.client')} }\n}\n`,
      },
      unresolved: [['a.ts', 17, 'cannot be traced']],
    },
    {
      name: 'an untyped parameter of a local helper is followed when every call passes the client',
      rules: mp,
      files: {
        'a.js': `${imp}const cf = new Acme();\nasync function zone(c, name) {\n  return ${call('c')}\n}\nconst run = (c = cf) => ${call('c')}\nzone(cf, 'x');\nzone(cf, 'y');\nrun();\nrun(cf);\n`,
      },
      expect: {
        'a.js': `${imp}const cf = new Acme();\nasync function zone(c, name) {\n  return ${done('c')}\n}\nconst run = (c = cf) => ${done('c')}\nzone(cf, 'x');\nzone(cf, 'y');\nrun();\nrun(cf);\n`,
      },
      unresolved: [],
    },
    {
      name: 'a helper parameter is not followed when a call passes something else or the helper escapes',
      rules: mp,
      files: {
        'a.js': `${imp}const cf = new Acme();\nfunction one(c) { ${call('c')} }\none(cf);\none(makeFake());\nfunction two(c) { ${call('c')} }\ntwo(cf);\nsetTimeout(two, 1);\nfunction three(c) { ${call('c')} }\nthree.bind(null, cf)();\n`,
      },
      expect: {},
      untouched: ['a.js'],
      unresolved: [['a.js', 3, 'cannot be traced'], ['a.js', 6, 'cannot be traced'], ['a.js', 9, 'cannot be traced']],
    },
  ];
}

// positional-to-named, as in Cloudflare 7: retrieve(parentId, childId) becomes retrieve(childId, { parent_id }).
function positionalCases() {
  const rule = [{ id: 'pn', kind: 'positional-to-named', match: { call: 'parents.children.retrieve', positional: 2 }, transform: { names: ['parent_id'] } }];
  const imp = "import Acme from 'acme-sdk';\nconst c = new Acme();\n";
  return [
    {
      name: 'positional-to-named moves leading arguments into the params object',
      rules: rule,
      files: {
        'a.ts': `${imp}c.parents.children.retrieve('p_1', 'c_1');\nc.parents.children.retrieve(p.id, childId, { zone_id: z });\nc.parents.children.retrieve(pid, cid, {});\nc.parents.children.retrieve(pid, cid, opts, { timeout: 5 });\nc.parents.children.retrieve(pid, cid, {\n  zone_id: z,\n  name: 'n',\n});\nc.parents.children.retrieve('c_2', { parent_id: 'p_2' });\n`,
      },
      expect: {
        'a.ts': `${imp}c.parents.children.retrieve('c_1', { parent_id: 'p_1' });\nc.parents.children.retrieve(childId, { parent_id: p.id, zone_id: z });\nc.parents.children.retrieve(cid, { parent_id: pid });\nc.parents.children.retrieve(cid, { parent_id: pid, ...opts }, { timeout: 5 });\nc.parents.children.retrieve(cid, { parent_id: pid,\n  zone_id: z,\n  name: 'n',\n});\nc.parents.children.retrieve('c_2', { parent_id: 'p_2' });\n`,
      },
      unresolved: [],
    },
    {
      name: 'positional-to-named queues calls it cannot move safely',
      rules: rule,
      files: {
        'a.ts': `${imp}c.parents.children.retrieve(await getParent(), cid);\nc.parents.children.retrieve(...ids);\nc.parents.children.retrieve(pid, cid, { parent_id: other });\nc.parents.children.retrieve(pid);\nfunction f(x) { return x.parents.children.retrieve(pid, cid); }\n`,
      },
      expect: {},
      untouched: ['a.ts'],
      unresolved: [['a.ts', 3, 'side effects'], ['a.ts', 4, 'spread argument'], ['a.ts', 5, 'already has one of parent_id'], ['a.ts', 6, 'not called with 2 positional arguments'], ['a.ts', 7, 'cannot be traced']],
    },
  ];
}

// rename-option, as in a client option renamed in new Acme({ ... }) or zod 4's { message } to { error }.
function optionCases() {
  const option = (id, call, arg, key, to) => ({ id, kind: 'rename-option', match: { call, arg, key }, transform: { to } });
  const client = [option('url', 'new default', 0, 'baseUrl', 'baseURL'), option('url-named', 'new Client', 0, 'baseUrl', 'baseURL'), option('key', 'new default', 0, 'apiKey', 'api-key')];
  return [
    {
      name: 'rename-option renames a client option however the client is constructed',
      rules: client,
      files: {
        'a.ts': [
          "import Acme, { Client } from 'acme-sdk';",
          "import * as acme from 'acme-sdk';",
          'const baseUrl = process.env.URL;',
          "export const a = new Acme({ baseUrl, apiKey: 'k' });",
          "export const b = new Client({ 'baseUrl': 'b' });",
          "export const c = new acme.Client({ baseUrl: 'c' });",
          'export const d = new acme.default({',
          "  baseUrl: 'd',",
          '});',
          "export const e = new Acme(({ baseUrl: 'e' }) as const);",
          'export const f = new Acme();',
          "export const g = new Acme({ baseURL: 'g' });",
          '',
        ].join('\n'),
        'b.js': "const Acme = require('acme-sdk');\nconst { Client } = require('acme-sdk');\nmodule.exports = { a: new Acme({ baseUrl: 'a' }), b: new Client({ baseUrl: 'b' }) };\n",
      },
      expect: {
        'a.ts': [
          "import Acme, { Client } from 'acme-sdk';",
          "import * as acme from 'acme-sdk';",
          'const baseUrl = process.env.URL;',
          "export const a = new Acme({ baseURL: baseUrl, \"api-key\": 'k' });",
          "export const b = new Client({ 'baseURL': 'b' });",
          "export const c = new acme.Client({ baseURL: 'c' });",
          'export const d = new acme.default({',
          "  baseURL: 'd',",
          '});',
          "export const e = new Acme(({ baseURL: 'e' }) as const);",
          'export const f = new Acme();',
          "export const g = new Acme({ baseURL: 'g' });",
          '',
        ].join('\n'),
        'b.js': "const Acme = require('acme-sdk');\nconst { Client } = require('acme-sdk');\nmodule.exports = { a: new Acme({ baseURL: 'a' }), b: new Client({ baseURL: 'b' }) };\n",
      },
      unresolved: [],
    },
    {
      name: 'rename-option renames a key in a chained call and leaves strings, other methods and migrated objects alone',
      rules: [option('min', 'min', 1, 'message', 'error'), option('string', 'z.string', 0, 'message', 'error')],
      extra: { package: 'zod' },
      files: {
        'a.ts': [
          "import { z } from 'zod';",
          "const message = 'Too short';",
          "export const name = z.string({ message: 'Required' }).min(2, { message });",
          "export const code = z.string().min(4, { 'message': 'Four', inclusive: true }).max(8, { message: 'Eight' });",
          "export const plain = z.string().min(1, 'Required');",
          "export const done = z.string().min(1, { error: 'Required' });",
          'export const bare = z.string().min(1);',
          '',
        ].join('\n'),
      },
      expect: {
        'a.ts': [
          "import { z } from 'zod';",
          "const message = 'Too short';",
          "export const name = z.string({ error: 'Required' }).min(2, { error: message });",
          "export const code = z.string().min(4, { 'error': 'Four', inclusive: true }).max(8, { message: 'Eight' });",
          "export const plain = z.string().min(1, 'Required');",
          "export const done = z.string().min(1, { error: 'Required' });",
          'export const bare = z.string().min(1);',
          '',
        ].join('\n'),
      },
      unresolved: [],
    },
    {
      name: 'rename-option queues a variable, a spread, a computed key, an accessor and an object that already has the new key',
      rules: [client[0]],
      files: {
        'a.ts': [
          "import Acme from 'acme-sdk';",
          "const opts = { baseUrl: 'x' };",
          'export const a = new Acme(opts);',
          "export const b = new Acme({ ...opts, apiKey: 'k' });",
          "export const c = new Acme({ [key]: 'x' });",
          "export const d = new Acme({ baseUrl: 'old', baseURL: 'new' });",
          "export const e = new Acme({ get baseUrl() { return 'x'; } });",
          'export const f = new Acme(load());',
          '',
        ].join('\n'),
      },
      expect: {},
      untouched: ['a.ts'],
      unresolved: [
        ['a.ts', 3, 'argument 0 of new default is not an object literal'],
        ['a.ts', 4, 'spreads an object that may hold baseUrl'],
        ['a.ts', 5, 'has a computed key that may be baseUrl'],
        ['a.ts', 6, 'already has baseURL'],
        ['a.ts', 7, 'baseUrl in argument 0 of new default is a method or accessor'],
        ['a.ts', 8, 'is not an object literal'],
      ],
    },
    {
      name: 'rename-option ignores lookalikes on another library, and queues an untraced call or another export only when its argument has the key',
      rules: [client[1], option('idem', 'charges.create', 1, 'idempotency_key', 'idempotencyKey')],
      files: {
        'a.ts': [
          "import { Client } from 'acme-sdk';",
          "import Other from 'other-sdk';",
          'const o = new Other();',
          "export const a = new Other.Client({ baseUrl: 'a' });",
          "o.charges.create({}, { idempotency_key: 'k' });",
          "export function make(Client) { return new Client({ baseUrl: 'b' }); }",
          "export function plain(Client) { return new Client({ apiKey: 'k' }); }",
          "export function pay(x) { return x.charges.create({}, { idempotency_key: 'k' }); }",
          'export function list(x) { return x.charges.create({}); }',
          "export const c = new Client({ baseUrl: 'c' });",
          "c.charges.create({ amount: 1 }, { idempotency_key: 'k' });",
          '',
        ].join('\n'),
        'b.ts': "class Client { constructor(o: object) {} }\nexport const c = new Client({ baseUrl: 'local' });\n",
        'c.ts': "import Client from 'acme-sdk';\nexport const d = new Client({ baseUrl: 'd' });\n",
      },
      expect: {
        'a.ts': [
          "import { Client } from 'acme-sdk';",
          "import Other from 'other-sdk';",
          'const o = new Other();',
          "export const a = new Other.Client({ baseUrl: 'a' });",
          "o.charges.create({}, { idempotency_key: 'k' });",
          "export function make(Client) { return new Client({ baseUrl: 'b' }); }",
          "export function plain(Client) { return new Client({ apiKey: 'k' }); }",
          "export function pay(x) { return x.charges.create({}, { idempotency_key: 'k' }); }",
          'export function list(x) { return x.charges.create({}); }',
          "export const c = new Client({ baseURL: 'c' });",
          "c.charges.create({ amount: 1 }, { idempotencyKey: 'k' });",
          '',
        ].join('\n'),
      },
      untouched: ['b.ts', 'c.ts'],
      unresolved: [
        ['a.ts', 6, 'receiver of new Client cannot be traced to acme-sdk'],
        ['a.ts', 8, 'receiver of charges.create cannot be traced to acme-sdk'],
        ['c.ts', 2, 'new Client uses the default export of acme-sdk, which may not be Client'],
      ],
    },
    {
      name: 'rename-option renames calls of the default export itself, and a manual rule queues constructor calls',
      rules: [option('verbose', 'default', 0, 'verbose', 'debug'), { id: 'region', kind: 'manual', match: { call: 'new Client' }, fallback: { prompt: 'Pass the region.' } }],
      files: {
        'a.ts': "import make, { Client } from 'acme-sdk';\nexport const m = make({ verbose: true });\nexport const c = new Client();\nexport const l = Client.list({ verbose: true });\n",
        'b.js': "const make = require('acme-sdk');\nmodule.exports = make({ verbose: false });\n",
      },
      expect: {
        'a.ts': "import make, { Client } from 'acme-sdk';\nexport const m = make({ debug: true });\nexport const c = new Client();\nexport const l = Client.list({ verbose: true });\n",
        'b.js': "const make = require('acme-sdk');\nmodule.exports = make({ debug: false });\n",
      },
      unresolved: [['a.ts', 3, 'manual rule: call site needs a migration']],
    },
  ];
}

// Clients cached on the global object so they survive hot reloads, as in Next.js and Prisma's guide.
function globalCacheCases() {
  const imp = "import Acme from 'acme-sdk';\n";
  const nextStyle = `${imp}declare global {\n  var __acme: Acme | undefined;\n}\nfunction makeAcme() {\n  if (!process.env.KEY) throw new Error('no key');\n  return new Acme();\n}\nexport const acme = globalThis.__acme ?? makeAcme();\nif (process.env.NODE_ENV !== 'production') globalThis.__acme = acme;\n`;
  const prismaStyle = `${imp}const globalForAcme = globalThis as unknown as { acme: Acme | undefined };\nexport const acme = globalForAcme.acme ?? new Acme();\nif (process.env.NODE_ENV !== 'production') globalForAcme.acme = acme;\n`;
  const use = "import { acme } from './lib/acme';\nacme.charges.create({ amount_cents: 1 });\n";
  const used = "import { acme } from './lib/acme';\nacme.payments.create({ amount: 1 });\n";
  return [
    { name: 'a client cached on globalThis is followed', rules: mp, files: { 'lib/acme.ts': nextStyle, 'route.ts': use }, expect: { 'route.ts': used }, unresolved: [] },
    { name: 'a client cached through a const alias of globalThis is followed', rules: mp, files: { 'lib/acme.ts': prismaStyle, 'route.ts': use }, expect: { 'route.ts': used }, unresolved: [] },
    {
      name: 'a global cache that is given another value, or written with a computed key, is not trusted',
      rules: mp,
      files: {
        'lib/acme.ts': nextStyle,
        'test/setup.ts': 'globalThis.__acme = makeFake();\n',
        'route.ts': use,
        'lib2/acme.ts': prismaStyle,
        'lib2/patch.ts': "const key = 'acme';\n(globalThis as any)[key] = makeFake();\n",
        'route2.ts': use.replace('./lib/acme', './lib2/acme'),
      },
      expect: {},
      untouched: ['route.ts', 'route2.ts'],
      unresolved: [['route.ts', 2, 'cannot be traced'], ['route2.ts', 2, 'cannot be traced']],
    },
  ];
}

// rename-namespace moves a whole resource, such as client.robotsPreview to client.robots.
function namespaceCases() {
  const ns = [{ id: 'ns', kind: 'rename-namespace', match: { path: 'robotsPreview' }, transform: { to: 'robots' } }];
  const imp = "import Acme from 'acme-sdk';\n";
  return [
    {
      name: 'rename-namespace renames calls, reads, factory results and destructuring',
      rules: ns,
      files: {
        'lib.ts': `${imp}export const client = new Acme();\nexport const getClient = () => client;\n`,
        'a.ts': "import { client, getClient } from './lib';\nawait client.robotsPreview.jobs.list();\nconst jobs = client.robotsPreview.jobs;\ngetClient().robotsPreview.jobs.moderate.create({});\nconst { robotsPreview } = client;\nconst { robotsPreview: rp } = getClient();\nclient.video.robotsPreview.x();\n",
      },
      expect: { 'a.ts': "import { client, getClient } from './lib';\nawait client.robots.jobs.list();\nconst jobs = client.robots.jobs;\ngetClient().robots.jobs.moderate.create({});\nconst { robots: robotsPreview } = client;\nconst { robots: rp } = getClient();\nclient.video.robotsPreview.x();\n" },
      unresolved: [],
    },
    {
      name: 'rename-namespace with a dotted path, and what it leaves alone or queues',
      rules: [{ id: 'ns', kind: 'rename-namespace', match: { path: 'data.filters' }, transform: { to: 'data.dimensions' } }],
      files: {
        'a.ts': `${imp}import Other from 'other-sdk';\nconst c = new Acme();\nc.data.filters.listValues('id');\nnew Other().data.filters.listValues('id');\nfunction f(x) { return x.data.filters.listValues('id'); }\nc.data?.filters.listValues('id');\nconst { data } = c;\n`,
        'unrelated.ts': "export const v = thing.data.filters;\n",
      },
      expect: { 'a.ts': `${imp}import Other from 'other-sdk';\nconst c = new Acme();\nc.data.dimensions.listValues('id');\nnew Other().data.filters.listValues('id');\nfunction f(x) { return x.data.filters.listValues('id'); }\nc.data?.filters.listValues('id');\nconst { data } = c;\n` },
      untouched: ['unrelated.ts'],
      unresolved: [['a.ts', 6, 'cannot be traced'], ['a.ts', 7, 'optional chaining']],
    },
  ];
}

// Type names, as in Mux 15: the resource property robotsPreview became robots and its type namespace
// RobotsPreview became Robots, in a module that moved from resources/robots-preview to resources/robots.
function typeNameCases() {
  const rules = [
    { id: 'sub', kind: 'rename-import', match: { module: 'acme-sdk/resources/robots-preview' }, transform: { to: 'acme-sdk/resources/robots' } },
    { id: 'ns', kind: 'rename-namespace', match: { path: 'robotsPreview' }, transform: { to: 'robots' } },
    { id: 'type', kind: 'rename-namespace', match: { path: 'RobotsPreview' }, transform: { to: 'Robots' } },
  ];
  const sub = "'acme-sdk/resources/robots-preview'";
  const moved = "'acme-sdk/resources/robots'";
  return [
    {
      name: 'type names are renamed after default, namespace and aliased imports, in typeof and in heritage clauses',
      rules,
      files: {
        'a.ts': `import Acme from 'acme-sdk';\nimport * as acme from 'acme-sdk';\nimport { default as A } from 'acme-sdk';\nimport { RobotsPreview as RP } from ${sub};\nconst client = new Acme();\ntype J1 = Acme.RobotsPreview.Job;\ntype J2 = acme.default.RobotsPreview.Job;\ntype J3 = A.RobotsPreview.Job;\ntype J4 = RP.Job;\ntype R = typeof client.robotsPreview;\ntype L = ReturnType<typeof client.robotsPreview.jobs.list>;\nclass Jobs extends Acme.RobotsPreview {}\ninterface Job extends Acme.RobotsPreview.Job {}\nclass Impl implements acme.default.RobotsPreview.Job {}\nimport Alias = Acme.RobotsPreview;\n`,
      },
      expect: {
        'a.ts': `import Acme from 'acme-sdk';\nimport * as acme from 'acme-sdk';\nimport { default as A } from 'acme-sdk';\nimport { Robots as RP } from ${moved};\nconst client = new Acme();\ntype J1 = Acme.Robots.Job;\ntype J2 = acme.default.Robots.Job;\ntype J3 = A.Robots.Job;\ntype J4 = RP.Job;\ntype R = typeof client.robots;\ntype L = ReturnType<typeof client.robots.jobs.list>;\nclass Jobs extends Acme.Robots {}\ninterface Job extends Acme.Robots.Job {}\nclass Impl implements acme.default.Robots.Job {}\nimport Alias = Acme.Robots;\n`,
      },
      unresolved: [],
    },
    {
      name: 'names brought in by import type, export from and require are renamed with the local name kept',
      rules,
      files: {
        'types.ts': `import type Acme from 'acme-sdk';\nimport type { RobotsPreview } from ${sub};\nimport { type RobotsPreview as Preview, type JobStatus } from ${sub};\nexport type { RobotsPreview } from ${sub};\nexport type Status = RobotsPreview.JobStatus | Preview.JobStatus | JobStatus | Acme.RobotsPreview.JobStatus;\n`,
        'b.js': `const { RobotsPreview } = require(${sub});\nmodule.exports = { RobotsPreview };\n`,
      },
      expect: {
        'types.ts': `import type Acme from 'acme-sdk';\nimport type { Robots as RobotsPreview } from ${moved};\nimport { type Robots as Preview, type JobStatus } from ${moved};\nexport type { Robots as RobotsPreview } from ${moved};\nexport type Status = RobotsPreview.JobStatus | Preview.JobStatus | JobStatus | Acme.Robots.JobStatus;\n`,
        'b.js': `const { Robots: RobotsPreview } = require(${moved});\nmodule.exports = { RobotsPreview };\n`,
      },
      unresolved: [],
    },
    {
      name: 'JSDoc types and import() types are renamed, a JSDoc link is not',
      rules,
      files: {
        'a.js': `const Acme = require('acme-sdk');\n/** @type {Acme.RobotsPreview.Job} */\nlet job;\n/**\n * @param {import(${sub}).RobotsPreview} rp\n * @param {import('acme-sdk').default.RobotsPreview.Job} j\n * @returns {typeof import(${sub}).RobotsPreview}\n */\nfunction f(rp, j) { return rp; }\n/** See {@link Acme.RobotsPreview}. */\nmodule.exports = { f, job };\n`,
        'b.ts': `export type J = import(${sub}).RobotsPreview.Job;\nexport type K = import('acme-sdk').default.RobotsPreview;\n`,
      },
      expect: {
        'a.js': `const Acme = require('acme-sdk');\n/** @type {Acme.Robots.Job} */\nlet job;\n/**\n * @param {import(${moved}).Robots} rp\n * @param {import('acme-sdk').default.Robots.Job} j\n * @returns {typeof import(${moved}).Robots}\n */\nfunction f(rp, j) { return rp; }\n/** See {@link Acme.RobotsPreview}. */\nmodule.exports = { f, job };\n`,
        'b.ts': `export type J = import(${moved}).Robots.Job;\nexport type K = import('acme-sdk').default.Robots;\n`,
      },
      unresolved: [],
    },
    {
      name: 'a local type with the same name is not touched, and a type name that cannot be traced is queued',
      rules,
      files: {
        'a.ts': "import Acme from 'acme-sdk';\nimport Other from 'other-sdk';\nimport type { Acme as Named } from 'acme-sdk';\ndeclare namespace Local { namespace RobotsPreview { type Job = string } }\ninterface RobotsPreview { id: string }\ntype A = Local.RobotsPreview.Job;\ntype B = RobotsPreview;\ntype C = Other.RobotsPreview.Job;\ntype D = Named.RobotsPreview.Job;\ndeclare const loose: any;\ntype E = typeof loose.robotsPreview;\nexport type All = [A, B, C, D, E, Acme];\n",
        'unrelated.ts': 'declare const x: any;\nexport type T = typeof x.robotsPreview;\n',
      },
      expect: {},
      untouched: ['a.ts', 'unrelated.ts'],
      unresolved: [['a.ts', 9, 'follows Named, which is imported by name'], ['a.ts', 11, 'type name robotsPreview cannot be traced']],
    },
  ];
}

// Clients shared between files through CommonJS require and module.exports.
function commonJsCases() {
  const req = "const Acme = require('acme-sdk');\n";
  const call = (recv) => `${recv}.charges.create({ amount_cents: 1 });\n`;
  const done = (recv) => `${recv}.payments.create({ amount: 1 });\n`;
  const shapes = [
    ['module.exports object with a shorthand property, destructured', `${req}const client = new Acme();\nmodule.exports = { client };\n`, "const { client } = require('./lib');\n", 'client'],
    ['module.exports object, read as a property', `${req}module.exports = { client: new Acme(), version: 2 };\n`, "const lib = require('./lib');\n", 'lib.client'],
    ['exports.client assignment', `${req}exports.client = new Acme();\n`, "const { client } = require('./lib');\n", 'client'],
    ['module.exports set to the client', `${req}module.exports = new Acme();\n`, "const client = require('./lib');\n", 'client'],
    ['ESM named import of a CommonJS export', `${req}const client = new Acme();\nmodule.exports = { client };\n`, "import { client } from './lib.js';\n", 'client'],
    ['ESM default import of module.exports', `${req}module.exports = new Acme();\n`, "import client from './lib.js';\n", 'client'],
    ['CommonJS factory with a lazy cache', `${req}let c;\nfunction getClient() { if (!c) c = new Acme(); return c; }\nmodule.exports = { getClient };\n`, "const { getClient } = require('./lib');\n", 'getClient()'],
  ];
  return [
    ...shapes.map(([name, lib, head, recv]) => ({
      name: `CommonJS: ${name}`,
      rules: mp,
      files: { 'lib.js': lib, 'use.js': head + call(recv) },
      expect: { 'use.js': head + done(recv) },
      unresolved: [],
    })),
    {
      name: 'CommonJS: an export assigned again is not trusted, and an unresolved relative require is queued',
      rules: mp,
      files: {
        'lib.js': `${req}module.exports = { client: new Acme() };\nif (process.env.TEST) module.exports.client = makeFake();\n`,
        'use.js': `const { client } = require('./lib');\n${call('client')}`,
        'missing.js': `${req}const { other } = require('./not-there');\n${call('other')}`,
      },
      expect: {},
      untouched: ['use.js', 'missing.js'],
      unresolved: [['use.js', 2, 'cannot be traced'], ['missing.js', 3, 'cannot be traced']],
    },
  ];
}

// Clients returned by factory functions and held in lazily assigned variables.
function factoryCases() {
  const before = (recv) => `${recv}.charges.create({ amount_cents: 1 });\n`;
  const after = (recv) => `${recv}.payments.create({ amount: 1 });\n`;
  const imp = "import Acme from 'acme-sdk';\n";
  return [
    {
      name: 'a factory function that returns a new instance, after checks that throw',
      rules: mp,
      files: { 'a.ts': `${imp}function getClient() {\n  if (!process.env.KEY) throw new Error('no key');\n  return new Acme({ key: process.env.KEY });\n}\n${before('getClient()')}const c = getClient();\n${before('c')}` },
      expect: { 'a.ts': `${imp}function getClient() {\n  if (!process.env.KEY) throw new Error('no key');\n  return new Acme({ key: process.env.KEY });\n}\n${after('getClient()')}const c = getClient();\n${after('c')}` },
      unresolved: [],
    },
    {
      name: 'arrow, async and chained factories imported from another file',
      rules: mp,
      files: {
        'lib/client.ts': `${imp}const create = () => new Acme();\nexport const requireClient = () => {\n  if (!process.env.KEY) throw new Error('no key');\n  return create();\n};\nexport async function loadClient() {\n  return new Acme();\n}\n`,
        'a.ts': `import { requireClient, loadClient } from './lib/client';\n${before('requireClient()')}const c = await loadClient();\n${before('c')}`,
      },
      expect: { 'a.ts': `import { requireClient, loadClient } from './lib/client';\n${after('requireClient()')}const c = await loadClient();\n${after('c')}` },
      unresolved: [],
    },
    {
      name: 'a factory that may return null or undefined',
      rules: mp,
      files: { 'a.ts': `${imp}export function getClient(): Acme | null {\n  if (!process.env.KEY) return null;\n  if (process.env.OFF) return;\n  return new Acme();\n}\nconst c = getClient();\n${before('c!')}` },
      expect: { 'a.ts': `${imp}export function getClient(): Acme | null {\n  if (!process.env.KEY) return null;\n  if (process.env.OFF) return;\n  return new Acme();\n}\nconst c = getClient();\n${after('c!')}` },
      unresolved: [],
    },
    {
      name: 'lazily cached clients in a module variable',
      rules: mp,
      files: {
        'lib/a.ts': `${imp}let cached: Acme | null = null;\nexport function getA(): Acme {\n  if (!cached) {\n    cached = new Acme();\n  }\n  return cached;\n}\n`,
        'lib/b.ts': `${imp}let client: Acme | undefined;\nexport function getB() {\n  if (client) return client;\n  client = new Acme();\n  return client;\n}\n`,
        'lib/c.ts': `${imp}let c: Acme | null = null;\nexport const getC = () => (c ??= new Acme());\nexport function reset() { c = null; }\n`,
        'use.ts': `import { getA } from './lib/a';\nimport { getB } from './lib/b';\nimport { getC } from './lib/c';\n${before('getA()')}${before('getB()')}${before('getC()')}`,
      },
      expect: { 'use.ts': `import { getA } from './lib/a';\nimport { getB } from './lib/b';\nimport { getC } from './lib/c';\n${after('getA()')}${after('getB()')}${after('getC()')}` },
      unresolved: [],
    },
    {
      name: 'a factory that can return something other than the client is not trusted',
      rules: mp,
      files: { 'a.ts': `${imp}function getClient() {\n  if (process.env.MOCK) return makeMock();\n  return new Acme();\n}\n${before('getClient()')}` },
      expect: {},
      untouched: ['a.ts'],
      unresolved: [['a.ts', 6, 'cannot be traced']],
    },
    {
      name: 'a cache that is ever given another value is not trusted',
      rules: mp,
      files: { 'a.ts': `${imp}let cached = null;\nexport function setForTests(fake) { cached = fake; }\nfunction get() {\n  if (!cached) cached = new Acme();\n  return cached;\n}\n${before('get()')}` },
      expect: {},
      untouched: ['a.ts'],
      unresolved: [['a.ts', 8, 'cannot be traced']],
    },
    {
      name: 'functions returning only null, generators and factories of another package are not followed',
      rules: mp,
      files: {
        'a.ts': `${imp}import Other from 'other-sdk';\nfunction none() { return null; }\nfunction* gen() { yield new Acme(); }\nconst other = () => new Other();\n${before('none()')}${before('gen()')}${before('other()')}`,
      },
      expect: {},
      untouched: ['a.ts'],
      unresolved: [['a.ts', 6, 'cannot be traced'], ['a.ts', 7, 'cannot be traced']],
    },
    {
      name: 'a recursive factory does not loop',
      rules: mp,
      files: { 'a.ts': `${imp}function get(n: number): Acme {\n  return n > 0 ? get(n - 1) : new Acme();\n}\n${before('get(3)')}` },
      expect: { 'a.ts': `${imp}function get(n: number): Acme {\n  return n > 0 ? get(n - 1) : new Acme();\n}\n${after('get(3)')}` },
      unresolved: [],
    },
    {
      name: 'a let that only ever holds the client is followed',
      rules: mp,
      files: { 'a.ts': `${imp}let c = new Acme();\n${before('c')}` },
      expect: { 'a.ts': `${imp}let c = new Acme();\n${after('c')}` },
      unresolved: [],
    },
  ];
}

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

function defaultImportCases() {
  const prompt = { prompt: 'Import the client by name.' };
  const root = [{ id: 'd', kind: 'manual', match: { import: 'default' }, fallback: prompt }];
  const legacy = [{ id: 'd', kind: 'manual', match: { import: 'default', module: 'acme-sdk/legacy', commonjs: true }, fallback: prompt }];
  const reason = 'manual rule: default import needs a migration';
  return [
    {
      name: 'a manual import rule queues each place that takes the default export of the package root',
      rules: root,
      files: {
        'a.ts': [
          "import Acme, { Jobs } from 'acme-sdk';",
          "import { default as Client } from 'acme-sdk';",
          "export { default } from 'acme-sdk';",
          "export { default as Acme2, Jobs as J } from 'acme-sdk';",
          "import * as acme from 'acme-sdk';",
          'export const c = new acme.default();',
          "export const lazy = (await import('acme-sdk')).default;",
          "const { default: Picked } = await import('acme-sdk');",
          "import type Typed from 'acme-sdk';",
          'new Acme(); new Client(); new Picked(); export type T = Typed; export const j: Jobs = null!;',
          '',
        ].join('\n'),
      },
      expect: {},
      untouched: ['a.ts'],
      unresolved: [['a.ts', 1, reason], ['a.ts', 2, reason], ['a.ts', 3, reason], ['a.ts', 4, reason], ['a.ts', 6, reason], ['a.ts', 7, reason], ['a.ts', 8, reason], ['a.ts', 9, reason]],
    },
    {
      name: 'a manual import rule leaves subpaths, other packages, named imports and require alone',
      rules: root,
      files: {
        'a.ts': "import Sub from 'acme-sdk/legacy';\nimport Other from 'acme-sdk-extra';\nimport { Jobs, type Job } from 'acme-sdk';\nimport * as acme from 'acme-sdk';\nnew Sub(); new Other(); new acme.Client(); export const j: Job = Jobs;\n",
        'b.js': "const Acme = require('acme-sdk');\nconst { Client } = require('acme-sdk');\nmodule.exports = { a: new Acme(), c: new Client() };\n",
      },
      expect: {},
      untouched: ['a.ts', 'b.js'],
      unresolved: [],
    },
    {
      name: 'a manual import rule for an `export =` subpath also queues require, import = require and namespace imports',
      rules: legacy,
      files: {
        'a.ts': "import Cache = require('acme-sdk/legacy');\nimport * as Legacy from 'acme-sdk/legacy';\nimport Plain from 'acme-sdk/legacy';\nimport Root from 'acme-sdk';\nnew Cache(); new Legacy(); new Plain(); new Root();\n",
        'b.js': "const Cache = require('acme-sdk/legacy');\nconst Root = require('acme-sdk');\nconst { get } = require('acme-sdk/legacy');\nmodule.exports = { c: new Cache(), r: new Root(), get };\n",
      },
      expect: {},
      untouched: ['a.ts', 'b.js'],
      unresolved: [['a.ts', 1, reason], ['a.ts', 2, reason], ['a.ts', 3, reason], ['b.js', 1, reason], ['b.js', 3, reason]],
    },
  ];
}

export const ruleSet = (rules, extra = {}) => ({ ...base, rules, ...extra });

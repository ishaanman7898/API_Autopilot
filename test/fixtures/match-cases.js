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
  ...globalCacheCases(),
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
];

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

export const ruleSet = (rules, extra = {}) => ({ ...base, rules, ...extra });

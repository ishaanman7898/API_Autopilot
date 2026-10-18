import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSpecs, draftRules } from '../src/diff.js';
import { signingBlockers, validateRuleSet } from '../src/rule.js';

const op = (operationId, extra = {}) => ({ operationId, responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } }, ...extra });
const body = (props, required = []) => ({ requestBody: { content: { 'application/json': { schema: { type: 'object', required, properties: props } } } } });
const spec = (paths, components) => ({ openapi: '3.0.3', paths, ...(components ? { components } : {}) });
const draft = (a, b, naming) => draftRules(diffSpecs(a, b), { provider: 'acme', pkg: 'acme-sdk', from: '1', to: '2', naming });
const find = (d, id) => d.ruleSet.rules.find((r) => r.id === id);

test('only OpenAPI 3.x is accepted', () => {
  assert.throws(() => diffSpecs({ swagger: '2.0' }, spec({})), /Swagger 2.0 is not supported/);
  assert.throws(() => diffSpecs(spec({}), { openapi: '2.1' }), /3\.x/);
  assert.throws(() => diffSpecs(null, spec({})), /JSON object/);
});

test('renamed operation on the same route is a rename, labelled by what was confirmed', () => {
  const a = spec({ '/charges': { post: op('charges_create') } });
  const b = spec({ '/charges': { post: op('payments_create') } });
  const unconfirmed = draft(a, b);
  const r = find(unconfirmed, 'rename-charges_create');
  assert.equal(r.kind, 'rename-method');
  assert.equal(r.confidence, 'needs-review');
  assert.match(r.evidence, /pass --naming/);
  const confirmed = find(draft(a, b, 'underscore'), 'rename-charges_create');
  assert.equal(confirmed.confidence, 'likely');
  assert.deepEqual([confirmed.match.call, confirmed.transform.to], ['charges.create', 'payments.create']);
});

test('a changed path with the same operationId is reported, not turned into a code rule', () => {
  const a = spec({ '/charges/{id}': { get: op('charges_get') } });
  const b = spec({ '/payments/{payment_id}': { get: op('charges_get') } });
  const d = draft(a, b, 'underscore');
  assert.deepEqual(d.ruleSet.rules, []);
  assert.deepEqual(d.report.pathChanges, [{ operation: 'charges_get', from: 'GET /charges/{id}', to: 'GET /payments/{payment_id}' }]);
});

test('a path and operationId that both changed is a guess, never likely', () => {
  const a = spec({ '/charges': { post: op('charges_create') } });
  const b = spec({ '/payments': { post: op('payments_create') } });
  const r = find(draft(a, b, 'underscore'), 'rename-charges_create');
  assert.equal(r.confidence, 'needs-review');
  assert.match(r.evidence, /guess/);
});

test('ambiguous operations are removals for the agent, not renames', () => {
  const a = spec({ '/a': { post: op('a_one') }, '/b': { post: op('b_one') } });
  const b = spec({ '/c': { post: op('c_one') }, '/d': { post: op('d_one') } });
  const d = draft(a, b, 'underscore');
  assert.ok(d.ruleSet.rules.every((r) => r.kind === 'manual' && r.confidence === 'needs-review'));
  assert.equal(d.ruleSet.rules.length, 2);
});

test('renamed body field with the same type is likely, with other types it is a removal plus an addition', () => {
  const p = (props) => spec({ '/charges': { post: op('charges_create', body(props)) } });
  const same = draft(p({ amount_cents: { type: 'integer' } }), p({ amount: { type: 'integer' } }), 'underscore');
  const r = same.ruleSet.rules.find((x) => x.kind === 'rename-param');
  assert.equal(r.confidence, 'likely');
  assert.deepEqual([r.match.param, r.transform.to, r.match.call], ['amount_cents', 'amount', 'charges.create']);
  const different = draft(p({ amount_cents: { type: 'integer' } }), p({ amount: { type: 'string' } }), 'underscore');
  assert.equal(different.ruleSet.rules.some((x) => x.kind === 'rename-param'), false);
  assert.ok(different.ruleSet.rules.every((x) => x.confidence === 'needs-review'));
  const ambiguous = draft(p({ a: { type: 'integer' }, b: { type: 'integer' } }), p({ c: { type: 'integer' }, d: { type: 'integer' } }), 'underscore');
  assert.equal(ambiguous.ruleSet.rules.some((x) => x.kind === 'rename-param'), false);
});

test('non-body parameter renames are always needs-review', () => {
  const q = (name) => spec({ '/charges': { get: op('charges_list', { parameters: [{ name, in: 'query', schema: { type: 'string' } }] }) } });
  const r = draft(q('starting_after'), q('cursor'), 'underscore').ruleSet.rules.find((x) => x.kind === 'rename-param');
  assert.equal(r.confidence, 'needs-review');
  assert.match(r.evidence, /positional/);
});

test('changed types, removed fields and new required parameters go to the agent', () => {
  const a = spec({ '/c': { post: op('c_create', body({ n: { type: 'integer' }, gone: { type: 'string' } })) } });
  const b = spec({ '/c': { post: op('c_create', { ...body({ n: { type: 'string' }, extra: { type: 'boolean' } }, ['extra']), responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } } }) } });
  const d = draft(a, b, 'underscore');
  const text = d.ruleSet.rules.map((r) => r.evidence + ' | ' + r.fallback?.prompt).join('\n');
  assert.match(text, /body parameter n changed from integer to string/);
  assert.match(text, /body parameter gone has no counterpart|body parameter gone/);
  assert.match(text, /new required body parameter extra/);
  assert.match(text, /response field id changed from string to integer/);
  assert.ok(d.ruleSet.rules.every((r) => r.kind === 'manual' && r.confidence === 'needs-review'));
});

test('$ref parameters, request bodies and allOf are resolved, and cycles do not hang', () => {
  const components = {
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
    schemas: {
      Base: { type: 'object', properties: { id: { type: 'string' } } },
      Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } },
      Loop: { $ref: '#/components/schemas/Loop' },
    },
  };
  const a = spec({ '/n': { get: op('n_list', { parameters: [{ $ref: '#/components/parameters/Limit' }] }), post: op('n_make', { requestBody: { content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/Base' }, { $ref: '#/components/schemas/Node' }] } } } } }) } }, components);
  const b = spec({ '/n': { get: op('n_list', { parameters: [{ name: 'limit', in: 'query', schema: { type: 'string' } }] }), post: op('n_make', { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Loop' } } } } }) } }, components);
  const d = draft(a, b, 'underscore');
  assert.ok(d.ruleSet.rules.some((r) => /query parameter limit changed from integer to string/.test(r.evidence)));
});

test('no draft rule ever claims certainty and drafts cannot be signed as they stand', () => {
  const a = spec({ '/charges': { post: op('charges_create', body({ amount_cents: { type: 'integer' } })) }, '/old': { get: op('old_get') } });
  const b = spec({ '/charges': { post: op('payments_create', body({ amount: { type: 'integer' } })) } });
  const d = draft(a, b, 'underscore');
  assert.deepEqual(validateRuleSet(d.ruleSet), []);
  assert.ok(d.ruleSet.rules.length >= 3);
  assert.ok(d.ruleSet.rules.every((r) => ['likely', 'needs-review'].includes(r.confidence) && r.evidence));
  assert.equal(d.ruleSet.draft, true);
  const blockers = signingBlockers(d.ruleSet);
  assert.ok(blockers.length >= 4);
  assert.deepEqual(signingBlockers({ rules: [{ id: 'x' }] }), []);
  assert.equal(new Set(d.ruleSet.rules.map((r) => r.id)).size, d.ruleSet.rules.length);
});

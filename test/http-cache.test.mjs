import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, SettingsStore, MaskingTransport, preview } from '../dist/core/index.js';

const identity = { sessionID: 'cache-session', agent: 'build', model: { providerID: 'local', id: 'model' }, kind: 'primary' };
const request = (input = 'auth', extra = {}) => new Request(extra.url ?? 'https://example.test/v1/responses', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: extra.authorization ?? 'Bearer fixture' },
  body: JSON.stringify({ instructions: 'Follow user-authored instructions about auth.', input })
});
async function fixture(t, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-cache-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const store = new SettingsStore(join(folder, 'config.json'));
  await store.save({ ...defaultSettings(), hosts: ['example.test', 'other.test'], patterns: ['(?i)auth', 'secret-\\d+'] });
  const transport = new MaskingTransport(store, options.now, options.idleTTL);
  t.after(() => transport.dispose());
  return { store, transport };
}
const masked = async (transport, input, who = identity, extra) => {
  const result = await transport.request(request(input, extra), who);
  return { ...result, value: await result.request.clone().json() };
};
const response = input => new Response(JSON.stringify({ output_text: input }), { headers: { 'content-type': 'application/json' } });

test('HTTP preserves masked instruction prefixes and history across sequential and concurrent session requests', async t => {
  const { transport } = await fixture(t);
  const first = await masked(transport, 'auth secret-1');
  const [second, third] = await Promise.all([
    masked(transport, 'secret-2 auth secret-1'),
    masked(transport, 'secret-3 auth secret-1')
  ]);
  assert(!first.value.instructions.includes('auth'));
  assert.equal(second.value.instructions, first.value.instructions);
  assert.equal(third.value.instructions, first.value.instructions);
  assert(second.value.input.endsWith(first.value.input));
  assert(third.value.input.endsWith(first.value.input));
  assert.notEqual(second.value.input.split(' ')[0], third.value.input.split(' ')[0]);
  const restored = await transport.response(third.request, response(third.value.input));
  assert.equal((await restored.json()).output_text, 'secret-3 auth secret-1');
  const earlier = await transport.response(first.request, response(first.value.input));
  assert.equal((await earlier.json()).output_text, 'auth secret-1');
});

test('HTTP isolates sessions, agents, models, operations, endpoints and credentials', async t => {
  const { transport } = await fixture(t);
  const first = await masked(transport, 'auth');
  for (const [who, extra] of [
    [{ ...identity, sessionID: 'other' }],
    [{ ...identity, agent: 'plan' }],
    [{ ...identity, model: { ...identity.model, id: 'other' } }],
    [{ ...identity, model: { ...identity.model, variant: 'high' } }],
    [{ ...identity, kind: 'title' }],
    [identity, { url: 'https://other.test/v1/responses' }],
    [identity, { authorization: 'Bearer other-fixture' }]
  ]) {
    const other = await masked(transport, 'auth', who, extra);
    assert.notEqual(other.value.input, first.value.input);
    const unchanged = await transport.response(other.request, response(first.value.input));
    assert.equal((await unchanged.json()).output_text, first.value.input);
  }
  assert.equal((await masked(transport, 'auth')).value.input, first.value.input);
  const anonymous = await transport.request(request());
  const anotherAnonymous = await transport.request(request());
  assert.notEqual((await anonymous.request.json()).input, (await anotherAnonymous.request.json()).input);
});

test('HTTP keeps per-request restoration snapshots while rules reload and masking toggles', async t => {
  const { transport, store } = await fixture(t);
  const first = await masked(transport, 'auth');
  await store.update(value => ({ ...value, enabled: false }));
  const unmodified = request();
  assert.equal((await transport.request(unmodified, identity)).request, unmodified);
  await store.update(value => ({ ...value, enabled: true, patterns: ['(?i)auth', 'secret-\\d+', 'private'] }));
  const second = await masked(transport, 'private auth');
  assert(second.value.input.endsWith(first.value.input));
  const futureMarker = second.value.input.split(' ')[0];
  const earlier = await transport.response(first.request, response(first.value.input + ' ' + futureMarker));
  assert.equal((await earlier.json()).output_text, 'auth ' + futureMarker);
  const later = await transport.response(second.request, response(second.value.input));
  assert.equal((await later.json()).output_text, 'private auth');
  await store.update(value => ({ ...value, patterns: ['(?i)\\bauth\\b'] }));
  const narrowed = await masked(transport, 'auth');
  assert.equal(narrowed.value.input, first.value.input);
  assert(narrowed.value.instructions.startsWith('Follow user-authored instructions'));
});

test('HTTP restores known session markers when the next request needs no replacements', async t => {
  const { transport } = await fixture(t);
  const first = await masked(transport, 'auth');
  const next = new Request('https://example.test/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
    body: JSON.stringify({ input: first.value.input, previous_response_id: 'response-fixture' })
  });
  const sent = await transport.request(next, identity);
  assert.equal(sent.statistics.replacements, 0);
  assert.equal(sent.request, next);
  const restored = await transport.response(sent.request, response(first.value.input));
  assert.equal((await restored.json()).output_text, 'auth');
});

test('HTTP expires idle contexts, removes deleted sessions and preserves outstanding response maps', async t => {
  let now = 0;
  const { transport } = await fixture(t, { now: () => now, idleTTL: 1000 });
  const first = await masked(transport, 'auth');
  now = 900;
  assert.equal((await masked(transport, 'auth')).value.input, first.value.input);
  now = 2000;
  const expired = await masked(transport, 'auth');
  assert.notEqual(expired.value.input, first.value.input);
  transport.remove(identity.sessionID);
  const removed = await masked(transport, 'auth');
  assert.notEqual(removed.value.input, expired.value.input);
  for (const sent of [first, expired, removed]) {
    const restored = await transport.response(sent.request, response(sent.value.input));
    assert.equal((await restored.json()).output_text, 'auth');
  }
  transport.dispose();
  await assert.rejects(transport.request(request(), identity), /остановлен/);
});

test('HTTP rejects oversized session maps without poisoning the queue or existing markers', async t => {
  const { transport } = await fixture(t);
  const first = await masked(transport, 'auth secret-1');
  await assert.rejects(masked(transport, Array.from({ length: 10001 }, (_, index) => 'secret-' + index).join(' ')), /лимит таблицы/);
  assert.equal((await masked(transport, 'auth secret-1')).value.input, first.value.input);
});

test('whole-word auth rule masks standalone values and leaves authored unchanged', async () => {
  const text = 'user-authored AUTH auth authorization oauth';
  const result = await preview({ ...defaultSettings(), patterns: ['(?i)\\bauth\\b'] }, text);
  assert.equal(result.statistics.replacements, 2);
  assert(result.value.startsWith('user-authored '));
  assert(result.value.endsWith(' authorization oauth'));
  assert.equal(result.restored, text);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, SettingsStore, WebSocketMaskingTransport, maskRequest } from '../dist/core/index.js';

const identity = { sessionID: 'session-one', agent: 'build', model: { providerID: 'local', id: 'model' }, kind: 'primary' };
const handshake = (extra = {}) => ({ ...identity, url: 'ws://localhost:8080/v1/responses', headers: { authorization: 'Bearer test-only' }, ...extra });
const frame = (value, extra = {}) => ({ ...identity, frame: JSON.stringify(value), ...extra });
const create = (input = 'private user-42', extra = {}) => ({ type: 'response.create', model: 'model', input: [{ role: 'user', content: input }], ...extra });
async function fixture(t, extra = {}, clock) {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-ws-unit-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const store = new SettingsStore(join(folder, 'config.json'));
  await store.save({ ...defaultSettings(), hosts: ['localhost:8080'], patterns: ['(?i)private', 'user-\\d+'], ...extra });
  const transport = new WebSocketMaskingTransport(store, clock, 10000); t.after(() => transport.dispose());
  await transport.handshake(handshake());
  return { store, transport };
}
const receive = (transport, value, extra) => { const event = frame(value, extra); transport.receive(event); return JSON.parse(event.frame); };

test('WebSocket uses the shared dictionary, preserves credentials and all protocol IDs', async t => {
  const { transport } = await fixture(t);
  const connect = handshake(); await transport.handshake(connect); assert.equal(connect.headers.authorization, 'Bearer test-only');
  const event = frame(create()); await transport.send(event);
  const payload = JSON.parse(event.frame), text = payload.input[0].content;
  assert(!text.includes('private')); assert(!text.includes('user-42'));
  receive(transport, { type: 'response.created', response: { id: 'resp-private' } });
  const answer = receive(transport, { type: 'response.output_text.done', item_id: 'item-private', stream_id: 'lane-private', text, response_id: 'resp-private', event_id: 'event-private' });
  assert.equal(answer.text, 'private user-42'); assert.equal(answer.item_id, 'item-private'); assert.equal(answer.response_id, 'resp-private');
  assert.equal(answer.stream_id, 'lane-private'); assert.equal(answer.event_id, 'event-private');
});

test('WebSocket restores every possible marker split, Unicode and independent delta channels', async t => {
  const { transport } = await fixture(t, { patterns: ['секрет🙂'] });
  const event = frame(create('секрет🙂')); await transport.send(event);
  const text = JSON.parse(event.frame).input[0].content;
  for (let split = 1; split < text.length; split++) {
    receive(transport, { type: 'response.created', response: { id: `resp-${split}` } });
    for (const family of ['response.output_text', 'response.reasoning_summary_text', 'response.function_call_arguments']) {
      const base = { item_id: 'item', output_index: 0, content_index: 0, summary_index: 0 };
      const first = receive(transport, { ...base, type: family + '.delta', delta: 'prefix ' + text.slice(0, split) });
      const second = receive(transport, { ...base, type: family + '.delta', delta: text.slice(split) + ' suffix' });
      assert.equal(first.delta + second.delta, 'prefix секрет🙂 suffix');
    }
    receive(transport, { type: 'response.completed', response: { id: `resp-${split}`, output: [] } });
  }
});

test('WebSocket stable mappings support continuation, settings reload and disabled masking', async t => {
  const { store, transport } = await fixture(t);
  const first = frame(create()); await transport.send(first); const masked = JSON.parse(first.frame).input[0].content;
  receive(transport, { type: 'response.created', response: { id: 'resp-first' } });
  receive(transport, { type: 'response.completed', response: { id: 'resp-first', output: [] } });
  await transport.handshake(handshake());
  const second = frame(create('private user-42', { previous_response_id: 'resp-first' })); await transport.send(second);
  assert.equal(JSON.parse(second.frame).input[0].content, masked);
  assert.equal(JSON.parse(second.frame).previous_response_id, 'resp-first');
  await store.update(settings => ({ ...settings, enabled: false })); await transport.handshake(handshake());
  const disabled = frame(create('private')); const original = disabled.frame; await transport.send(disabled); assert.equal(disabled.frame, original);
  assert.equal(receive(transport, { type: 'response.output_text.done', text: masked }).text, 'private user-42');
  await store.update(settings => ({ ...settings, enabled: true, patterns: ['fresh'] })); await transport.handshake(handshake());
  const third = frame(create('fresh private')); await transport.send(third);
  assert.match(JSON.parse(third.frame).input[0].content, /__P4P_.* private/);
});

test('unlisted hosts and sessions are unchanged; selected unsupported protocols fail before sending', async t => {
  const { transport } = await fixture(t);
  const other = { ...identity, sessionID: 'other' };
  await transport.handshake(handshake({ ...other, url: 'wss://unlisted.test' }));
  const binary = { ...other, frame: 'not-json' }; await transport.send(binary); transport.receive(binary); assert.equal(binary.frame, 'not-json');
  await assert.rejects(transport.send(frame({ type: 'session.update', session: { instructions: 'private' } })), /Responses API/);
  await assert.rejects(transport.send({ ...identity, frame: 'bad-json' }), /JSON/);
  await assert.rejects(transport.send(frame(create('private', { previous_response_id: 'unknown' }))), /предыдущего ответа/);
});

test('parallel lanes, tool results, final snapshots, cancellation and reconnect do not mix data', async t => {
  const { transport } = await fixture(t);
  const event = frame(create('private')); await transport.send(event); const marker = JSON.parse(event.frame).input[0].content;
  receive(transport, { type: 'response.created', stream_id: 'a', response: { id: 'resp-a' } });
  receive(transport, { type: 'response.created', stream_id: 'b', response: { id: 'resp-b' } });
  assert.equal(receive(transport, { type: 'response.output_text.delta', stream_id: 'a', item_id: 'a', delta: marker.slice(0, 12) }).delta, '');
  assert.equal(receive(transport, { type: 'response.output_text.delta', stream_id: 'b', item_id: 'b', delta: marker }).delta, 'private');
  assert.equal(receive(transport, { type: 'response.output_text.delta', stream_id: 'a', item_id: 'a', delta: marker.slice(12) }).delta, 'private');
  const done = receive(transport, { type: 'response.completed', stream_id: 'a', response: { id: 'resp-a', output: [{ type: 'message', content: [{ type: 'output_text', text: marker }] }] } });
  assert.equal(done.response.output[0].content[0].text, 'private');
  const result = frame({ type: 'response.create', input: [{ type: 'function_call_output', call_id: 'call-original', output: 'ERROR private user-42' }] }); await transport.send(result);
  assert.equal(JSON.parse(result.frame).input[0].call_id, 'call-original'); assert(!result.frame.includes('ERROR private'));
  receive(transport, { type: 'response.output_text.delta', item_id: 'old', delta: marker.slice(0, 20) });
  transport.interrupt(identity.sessionID);
  receive(transport, { type: 'response.created', response: { id: 'after-cancel' } });
  assert.equal(receive(transport, { type: 'response.output_text.delta', item_id: 'new', delta: marker }).delta, 'private');
  await transport.handshake(handshake({ headers: { authorization: 'Bearer rotated-test' } }));
  assert.equal(receive(transport, { type: 'response.output_text.done', text: marker }).text, marker);
});

test('idle expiry and deletion release state; active responses survive idle pruning', async t => {
  let time = 0; const { transport } = await fixture(t, {}, () => time);
  const first = frame(create('private')); await transport.send(first);
  time = 20000;
  await transport.handshake(handshake({ sessionID: 'different' }));
  assert.equal(receive(transport, { type: 'response.output_text.done', text: JSON.parse(first.frame).input[0].content }).text, 'private');
  receive(transport, { type: 'response.completed', response: { id: 'old-response', output: [] } });
  time = 40000; await transport.handshake(handshake());
  await assert.rejects(transport.send(frame(create('private', { previous_response_id: 'old-response' }))), /недоступна/);
  transport.remove(identity.sessionID);
  await transport.handshake(handshake());
  const second = frame(create('private')); await transport.send(second); assert.notEqual(second.frame, first.frame);
});

test('reused mappings preserve existing placeholders without nesting replacements', async () => {
  const settings = { ...defaultSettings(), patterns: ['private'] };
  const first = await maskRequest(settings, { input: 'private' });
  const second = await maskRequest({ ...settings, patterns: ['__P4P_.*?__', 'private'] }, { input: first.value.input + ' private' }, first.mapping);
  assert.equal(second.value.input, first.value.input + ' ' + first.value.input);
});

test('WebSocket bounds tables before sending and preserves the previous working state', async t => {
  const { transport } = await fixture(t, { patterns: ['entry-\\d+'] });
  const event = frame(create(Array.from({ length: 10001 }, (_, index) => 'entry-' + index).join(' ')));
  const original = event.frame;
  await assert.rejects(transport.send(event), /лимит таблицы/);
  assert.equal(event.frame, original);
  const next = frame(create('entry-1')); await transport.send(next);
  assert(!next.frame.includes('entry-1'));
  await assert.rejects(transport.send({ ...identity, frame: ' '.repeat(16 * 1024 * 1024 + 1) }), /16 МБ/);
});

test('WebSocket limits unfinished channels and restores after cancellation of a damaged stream', async t => {
  const { transport } = await fixture(t);
  const event = frame(create('private')); await transport.send(event); const marker = JSON.parse(event.frame).input[0].content;
  for (let index = 0; index < 1024; index++) receive(transport, { type: 'response.output_text.delta', item_id: 'item-' + index, delta: marker.slice(0, 9) });
  assert.throws(() => receive(transport, { type: 'response.output_text.delta', item_id: 'item-overflow', delta: marker.slice(0, 9) }), /фрагментов/);
  receive(transport, { type: 'response.created', response: { id: 'fresh-response' } });
  assert.equal(receive(transport, { type: 'response.output_text.delta', item_id: 'fresh', delta: marker }).delta, 'private');
});

test('unloading the WebSocket handler stops callbacks instead of forwarding unmasked frames', async t => {
  const { transport } = await fixture(t);
  transport.dispose();
  await assert.rejects(transport.handshake(handshake()), /остановлен/);
  await assert.rejects(transport.send(frame(create())), /остановлен/);
  assert.throws(() => transport.receive(frame({ type: 'response.created', response: { id: 'late' } })), /остановлен/);
});

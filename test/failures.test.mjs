import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { setImmediate } from 'node:timers/promises';
import { SettingsStore, defaultSettings, FailureStore, FailureCapture, FailureTickets, MaskingTransport, WebSocketMaskingTransport, redactDiagnostic } from '../dist/core/index.js';

const identity = { sessionID: 'session-fixture', agent: 'build', kind: 'primary', model: { providerID: 'local', id: 'fixture-model' } };
const call = promisify(execFile);
async function fixture(t, overrides = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-failure-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const settings = new SettingsStore(join(folder, 'config.json'));
  await settings.save({ ...defaultSettings(), patterns: ['personal-value'], hosts: ['example.test'], ...overrides });
  const store = new FailureStore(settings.path), capture = new FailureCapture(settings, store);
  t.after(() => capture.dispose());
  return { folder, settings, store, capture };
}
const payload = () => ({ model: 'fixture-model', stream: true, messages: [{ role: 'user', content: 'personal-value password="two word fixture"' }], metadata: { api_key: 'body-credential' } });
const request = () => new Request('https://example.test/v1/chat?api_key=url-credential', { method: 'POST', headers: { authorization: 'Bearer fixture-header-credential', 'content-type': 'application/json' }, body: JSON.stringify(payload()) });

test('journal summaries are JSON values before serialization, including cached entries without HTTP status', async t => {
  const { store, capture } = await fixture(t);
  await capture.httpStart({ ...identity, request: request() });
  await capture.wsHandshake({ ...identity, url: 'wss://example.test/v1/responses', headers: {} });
  await capture.wsStart({ ...identity, frame: '{"type":"response.create","input":"hello"}' });
  await capture.wsReceive({ ...identity, frame: '{"type":"response.completed"}' });
  for (let index = 0; index < 2; index++) {
    const listing = await store.listing();
    assert.deepEqual(listing.rows.map(row => row.status).sort(), ['succeeded', 'unknown']);
    assert.deepEqual(listing, JSON.parse(JSON.stringify(listing)));
  }
});

for (const requestLogFilter of ['all', 'succeeded', 'failed']) test(`HTTP and WebSocket journal persist only the selected outcomes: ${requestLogFilter}`, async t => {
  const { settings, store, capture } = await fixture(t, { requestLogFilter });
  const outcomes = [];
  const http = async (type, wire, status = 200) => {
    const req = request(), ticket = await capture.httpStart({ ...identity, request: req });
    assert(ticket);
    const response = new Response(wire, { status, headers: { 'content-type': type } });
    await capture.httpSent(ticket, req);
    await capture.httpResponse(req, response);
    assert.equal(await capture.observe(req, response).text(), wire);
    outcomes.push(ticket.row.status);
  };
  const pending = await capture.httpStart({ ...identity, request: request() });
  assert.equal((await store.listing()).rows.length, requestLogFilter === 'all' ? 1 : 0);
  capture.finish(identity.sessionID); outcomes.push('unknown');
  await http('application/json', '{"ok":true}');
  await http('application/json', '{"error":{"message":"HTTP fixture"}}', 422);
  await http('text/event-stream', 'data: [DONE]\n\n');
  await http('text/event-stream', 'event: error\ndata: {"error":{"message":"SSE fixture"}}\n\n');
  await http('text/event-stream', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  const cancelled = request(); await capture.httpStart({ ...identity, request: cancelled });
  await capture.observe(cancelled, new Response('partial')).body.cancel(); outcomes.push('unknown');
  const broken = request(); await capture.httpStart({ ...identity, request: broken });
  const response = capture.observe(broken, new Response(new ReadableStream({ pull(controller) { controller.error(new Error('stream fixture')); } })));
  await assert.rejects(response.text(), /stream fixture/); outcomes.push('failed');
  await capture.wsHandshake({ ...identity, url: 'wss://example.test/v1/responses', headers: {} });
  for (const [type, status] of [['response.completed', 'succeeded'], ['error', 'failed'], ['response.cancelled', 'unknown']]) {
    await capture.wsStart({ ...identity, frame: '{"type":"response.create","input":"hello"}' });
    await capture.wsReceive({ ...identity, frame: JSON.stringify({ type, ...(type === 'error' ? { error: { message: 'WebSocket fixture' } } : {}) }) });
    outcomes.push(status);
  }
  capture.finish(identity.sessionID);
  const expected = outcomes.filter(status => requestLogFilter === 'all' || status === requestLogFilter).sort();
  assert.deepEqual((await store.listing()).rows.map(row => row.status).sort(), expected);
  assert.deepEqual((await new FailureStore(settings.path).listing()).rows.map(row => row.status).sort(), expected);
  if (requestLogFilter !== 'all') await assert.rejects(store.read(pending.row.id), { code: 'ENOENT' });
});

test('journal mode is captured at request start and a later failure removes a success-only record', async t => {
  const { settings, store, capture } = await fixture(t, { requestLogFilter: 'succeeded' });
  await capture.wsHandshake({ ...identity, url: 'wss://example.test/v1/responses', headers: {} });
  const ticket = await capture.wsStart({ ...identity, frame: '{"type":"response.create","input":"hello"}' });
  await settings.update(value => ({ ...value, requestLogFilter: 'failed' }));
  await capture.wsReceive({ ...identity, frame: '{"type":"response.completed"}' });
  assert.equal((await store.read(ticket.row.id)).status, 'succeeded');
  await capture.wsFailure(identity, new Error('restoration fixture'));
  assert.equal((await store.listing()).rows.length, 0);
  const next = await capture.wsStart({ ...identity, frame: '{"type":"response.create","input":"hello"}' });
  await capture.wsReceive({ ...identity, frame: '{"type":"error","error":{"message":"fixture"}}' });
  assert.equal((await store.read(next.row.id)).status, 'failed');
});

for (const requestLogFilter of ['succeeded', 'failed']) test(`ambiguous transcript errors respect journal mode: ${requestLogFilter}`, async t => {
  const { store, capture } = await fixture(t, { requestLogFilter });
  await capture.httpStart({ ...identity, kind: 'primary', request: request() });
  await capture.httpStart({ ...identity, kind: 'title', request: request() });
  await capture.retry({ ...identity, error: { message: 'ambiguous fixture' } });
  const rows = (await store.listing()).rows;
  assert.equal(rows.length, requestLogFilter === 'failed' ? 1 : 0);
  if (rows.length) { assert.equal(rows[0].source, 'transcript'); assert.equal(rows[0].status, 'failed'); }
});

test('HTTP failure exports dashboard JSON with original and masked bodies, error, metrics and credential redaction', async t => {
  const { settings, store, capture } = await fixture(t), transport = new MaskingTransport(settings);
  const original = request(), ticket = await capture.httpStart({ ...identity, request: original });
  const sent = await transport.request(original); await capture.httpSent(ticket, sent.request, sent.statistics);
  const response = new Response(JSON.stringify({ error: { message: 'fixture-header-credential rejected', code: 'invalid_request' } }), { status: 422, headers: { 'content-type': 'application/json' } });
  await capture.httpResponse(sent.request, response);
  assert.equal((await response.json()).error.code, 'invalid_request');
  await capture.retry({ ...identity, error: { message: 'same failure', status: 422 } });
  const listing = await store.listing(); assert.equal(listing.rows.length, 1);
  const file = await store.export(listing.rows[0].id), row = JSON.parse(file.content);
  assert.equal(file.name, `model-request-${row.id}.json`);
  assert.equal(row.http_status, 422); assert.equal(row.status, 'failed'); assert.equal(row.source, 'http');
  assert.equal(row.session_id, identity.sessionID); assert.equal(row.model, identity.model.id); assert.equal(row.provider, 'local');
  assert.match(row.request.messages[0].content, /personal-value/); assert.match(row.masked_request.messages[0].content, /__P4P_/);
  assert(!JSON.stringify(row.masked_request).includes('personal-value'));
  assert.equal(row.request.metadata.api_key, '[REDACTED]'); assert.equal(row.message_count, 1);
  assert.equal(row.endpoint, 'https://example.test/v1/chat'); assert.equal(row.attempt, 1);
  assert.equal(row.prompt, null); assert.deepEqual(row.command, {}); assert.deepEqual(row.invocation, {});
  assert(row.request_bytes > 0); assert(row.upstream_request_bytes > 0); assert(row.duration_seconds >= 0); assert(row.first_byte_seconds >= 0);
  for (const value of ['fixture-header-credential', 'url-credential', 'body-credential', 'two word fixture']) assert(!file.content.includes(value), value);
  assert.equal((await stat(join(store.path, row.id + '.json'))).mode & 0o777, 0o600);
  const next = await capture.httpStart({ ...identity, request: request() }); assert.equal(next.row.attempt, 2); assert.equal(next.row.previous_request_id, row.id);
});

test('HTTP gzip and streaming errors are captured without consuming the returned response; successful and cancelled calls retain their outcomes', async t => {
  const { store, capture } = await fixture(t);
  const req = request(); await capture.httpStart({ ...identity, request: req });
  const response = new Response(gzipSync(JSON.stringify({ error: { message: 'temporary fixture error' } })), { status: 503, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  await capture.httpResponse(req, response); assert((await response.arrayBuffer()).byteLength > 0);
  assert.match((await store.read((await store.listing()).rows[0].id)).response_preview, /temporary fixture error/);
  const streamed = request(); await capture.httpStart({ ...identity, request: streamed });
  const wire = 'data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\nevent: error\ndata: {"error":{"message":"stream fixture error"}}\n\n';
  const outgoing = capture.observe(streamed, new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(await outgoing.text(), wire);
  const rows = await store.listing(); assert.equal(rows.rows.length, 2);
  const streamRow = await store.read(rows.rows.find(row => row.http_status === 200).id);
  assert.equal(streamRow.tokens.input_tokens, 12); assert.equal(streamRow.context_tokens, 12);
  const success = request(); await capture.httpStart({ ...identity, request: success });
  assert.equal(await capture.observe(success, new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })).text(), '{"ok":true}');
  const cancel = request(); await capture.httpStart({ ...identity, request: cancel });
  await capture.observe(cancel, new Response('unused')).body.cancel();
  capture.finish(identity.sessionID); assert.equal(capture.tickets.pending.size, 0);
  const outcomes = (await store.listing()).rows.map(row => row.status).sort();
  assert.deepEqual(outcomes, ['failed', 'failed', 'succeeded', 'unknown']);
});

test('cancelling an HTTP response during a pending read does not record a failure', async t => {
  for (const completed of [false, true]) await t.test(completed ? 'after the final SSE event' : 'before the first byte', async t => {
    const { store, capture } = await fixture(t);
    const req = request(); await capture.httpStart({ ...identity, request: req });
    const waiting = Promise.withResolvers(), reason = new Error('consumer finished');
    const wire = 'data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
    let sent = false, cancelled;
    const upstream = new ReadableStream({
      pull(controller) {
        if (completed && !sent) { sent = true; controller.enqueue(new TextEncoder().encode(wire)); }
        else waiting.resolve();
      },
      cancel(reason) { cancelled = reason; }
    }, { highWaterMark: 0 });
    const reader = capture.observe(req, new Response(upstream, { headers: { 'content-type': 'text/event-stream' } })).body.getReader();
    if (completed) assert.equal(new TextDecoder().decode((await reader.read()).value), wire);
    const pending = reader.read();
    await waiting.promise;
    await reader.cancel(reason);
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.equal(cancelled, reason);
    await setImmediate();
    const rows = (await store.listing()).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, completed ? 'succeeded' : 'unknown');
    assert.equal(rows[0].error, '');
  });
});

test('HTTP 200 upstream stream errors are still recorded and propagated', async t => {
  const { store, capture } = await fixture(t);
  const req = request(); await capture.httpStart({ ...identity, request: req });
  const error = new TypeError('Invalid state: Controller is already closed');
  const upstream = new ReadableStream({ pull(controller) { controller.error(error); } });
  const response = capture.observe(req, new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(response.text(), value => value === error);
  const rows = (await store.listing()).rows;
  assert.equal(rows.length, 1);
  const row = await store.read(rows[0].id);
  assert.equal(row.http_status, 200);
  assert.deepEqual(row.error, { type: 'TypeError', message: error.message });
});

test('request capture follows the enabled toggle and host list even with an empty dictionary', async t => {
  const { settings, store, capture } = await fixture(t, { patterns: [] });
  const ticket = await capture.httpStart({ ...identity, request: request() }); assert(ticket);
  await capture.httpFailure(request(), new Error('unrelated object'));
  assert.deepEqual((await store.listing()).rows.map(row => row.status), ['unknown']);
  await capture.retry({ ...identity, error: { type: 'network', message: 'fixture connection failed' } }); assert.equal((await store.listing()).rows.length, 1);
  await settings.update(value => ({ ...value, enabled: false })); assert.equal(await capture.httpStart({ ...identity, request: request() }), undefined);
  await settings.update(value => ({ ...value, enabled: true, hosts: [] })); assert.equal(await capture.httpStart({ ...identity, request: request() }), undefined);
  await settings.update(value => ({ ...value, hosts: ['example.test'], recordRequests: false }));
  const unrecorded = request();
  assert.equal(await capture.httpStart({ ...identity, request: unrecorded }), undefined);
  const response = capture.observe(unrecorded, new Response('{"ok":true}'));
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal((await store.listing()).rows.length, 1);
});

test('the journal persists unanswered requests and distinguishes completion from an interrupted response', async t => {
  const { settings, store, capture } = await fixture(t);
  const req = request(); await capture.httpStart({ ...identity, request: req });
  const pending = (await new FailureStore(settings.path).listing()).rows;
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'unknown');
  assert(!JSON.stringify(await store.read(pending[0].id)).includes('body-credential'));
  capture.finish(identity.sessionID);
  assert.equal((await store.read(pending[0].id)).status, 'unknown');
  const cases = [
    ['application/json', '{"ok":true,"usage":{"input_tokens":10}}', 'succeeded'],
    ['application/json', '{"error":{"message":"synthetic failure"}}', 'failed'],
    ['text/event-stream', 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', 'succeeded'],
    ['text/event-stream', 'data: {"type":"response.completed"}\n\n', 'succeeded'],
    ['text/event-stream', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'unknown']
  ];
  for (const [type, wire, expected] of cases) {
    const req = request(), ticket = await capture.httpStart({ ...identity, request: req });
    const response = new Response(wire, { headers: { 'content-type': type } });
    await capture.httpResponse(req, response);
    assert.equal(await capture.observe(req, response).text(), wire);
    const row = await store.read(ticket.row.id);
    assert.equal(row.status, expected); assert.equal(row.http_status, 200);
  }
  const empty = request(), ticket = await capture.httpStart({ ...identity, request: empty });
  await capture.httpResponse(empty, new Response(null, { status: 204 }));
  assert.equal((await store.read(ticket.row.id)).status, 'succeeded');
});

test('WebSocket journal recording can be disabled and enabled without reconnecting', async t => {
  const { settings, store, capture } = await fixture(t, { recordRequests: false });
  const handshake = { ...identity, url: 'wss://example.test/v1/responses', headers: {} };
  await capture.wsHandshake(handshake);
  const event = { ...identity, frame: '{"type":"response.create","model":"fixture-model","input":"hello"}' };
  assert.equal(await capture.wsStart(event), undefined);
  await settings.update(value => ({ ...value, recordRequests: true }));
  const ticket = await capture.wsStart(event); assert(ticket);
  await capture.wsReceive({ ...identity, frame: '{"type":"response.completed","response":{"usage":{"input_tokens":10}}}' });
  const row = await store.read(ticket.row.id);
  assert.equal(row.status, 'succeeded'); assert.equal(row.tokens.input_tokens, 10);
  capture.finish(identity.sessionID);
  const next = await capture.wsStart(event); assert(next);
  await capture.wsReceive({ ...identity, frame: '{"type":"response.completed"}' });
  await capture.wsFailure(identity, new Error('synthetic restoration failure'));
  const failed = await store.read(next.row.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.request.input, 'hello');
  await settings.update(value => ({ ...value, recordRequests: false }));
  assert.equal(await capture.wsStart(event), undefined);
  capture.finish(identity.sessionID);
  assert.equal((await store.listing()).rows.length, 2);
});

test('WebSocket exports the physical response.create frame, wire masking and failure without mixing parallel lanes', async t => {
  const { settings, store, capture } = await fixture(t), transport = new WebSocketMaskingTransport(settings); t.after(() => transport.dispose());
  const handshake = { ...identity, url: 'wss://example.test/v1/responses', headers: { authorization: 'Bearer ws-fixture-credential' } };
  await capture.wsHandshake(handshake); await transport.handshake(handshake);
  const send = async lane => {
    const event = { ...identity, frame: JSON.stringify({ type: 'response.create', stream_id: lane, model: 'fixture-model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'personal-value ' + lane }] }] }) };
    const ticket = await capture.wsStart(event), stats = await transport.send(event); capture.wsSent(ticket, event.frame, stats); return ticket;
  };
  await send('one'); await send('two');
  await capture.wsReceive({ ...identity, frame: JSON.stringify({ type: 'error', stream_id: 'two', error: { status: 422, message: 'ws-fixture-credential fixture error' } }) });
  const rows = (await store.listing()).rows; assert.equal(rows.length, 2);
  const row = await store.read(rows.find(row => row.status === 'failed').id); assert.equal(row.source, 'websocket'); assert.equal(row.http_status, 422);
  assert.equal(row.request.stream_id, 'two'); assert.match(JSON.stringify(row.request), /personal-value two/);
  assert(!JSON.stringify(row.masked_request).includes('personal-value')); assert(!JSON.stringify(row).includes('ws-fixture-credential'));
  await capture.wsReceive({ ...identity, frame: '{"type":"response.completed","stream_id":"one","response":{"usage":{"input_tokens":10}}}' });
  assert.deepEqual((await store.listing()).rows.map(row => row.status).sort(), ['failed', 'succeeded']);
});

test('ambiguous SDK errors export metadata rather than assigning a parallel request body', async t => {
  const { store, capture } = await fixture(t);
  await capture.httpStart({ ...identity, kind: 'primary', request: request() });
  await capture.httpStart({ ...identity, kind: 'title', request: request() });
  await capture.retry({ ...identity, error: { status: 500, message: 'parallel fixture fixture-header-credential', response: { body: { error: 'fixture-header-credential' } } } });
  const summaries = (await store.listing()).rows;
  assert.deepEqual(summaries.map(row => row.status).sort(), ['failed', 'unknown', 'unknown']);
  const row = await store.read(summaries.find(row => row.source === 'transcript').id);
  assert(!JSON.stringify(row).includes('fixture-header-credential')); assert.equal(row.source, 'transcript'); assert.equal(row.request, null); assert.equal(row.candidate_request_ids.length, 2); assert.match(row.coverage, /параллельными/);
});

test('failure storage isolates configurations, limits history, expires old rows and validates identifiers', async t => {
  const { folder, store } = await fixture(t), tickets = new FailureTickets(store);
  for (let index = 0; index < 52; index++) await tickets.fail(tickets.begin(identity, 'http', 'https://example.test', [], { index }, 20), { message: 'fixture' }, '', 422);
  assert.equal((await store.listing()).rows.length, 50);
  const other = new FailureStore(join(folder, 'other.json')); assert.equal((await other.listing()).rows.length, 0);
  await assert.rejects(store.export('../config')); await assert.rejects(store.read('a'.repeat(24)));
  const id = (await store.listing()).rows.at(-1).id, expired = join(store.path, id + '.json');
  await utimes(expired, new Date(0), new Date(0)); assert.equal((await store.listing()).rows.length, 49); await assert.rejects(stat(expired));
  await store.clear(); assert.equal((await store.listing()).rows.length, 0);
});

test('CLI lists and exports the latest error, protects existing files and the active config, then clears history', async t => {
  const { folder, settings, store } = await fixture(t), tickets = new FailureTickets(store), cli = resolve('dist/cli.js');
  const ticket = tickets.begin(identity, 'http', 'https://example.test', [], { messages: [] }, 15); await tickets.fail(ticket, { message: 'fixture' }, '', 422);
  const run = (...args) => call(process.execPath, [cli, '--config', settings.path, ...args]);
  const listed = JSON.parse((await run('requests', 'list', '--json')).stdout); assert.equal(listed.rows[0].id, ticket.row.id);
  const file = join(folder, 'error.json'); await run('requests', 'export', 'latest', file); assert.equal(JSON.parse(await readFile(file, 'utf8')).id, ticket.row.id);
  await assert.rejects(run('requests', 'export', 'latest', file)); await run('requests', 'export', 'latest', file, '--force');
  await assert.rejects(run('requests', 'export', 'latest', settings.path, '--force')); assert.equal((await settings.read()).settings.version, 1);
  assert.equal(JSON.parse((await run('requests', 'export', ticket.row.id)).stdout).http_status, 422);
  await run('requests', 'clear'); assert.equal((await store.listing()).rows.length, 0);
});

test('diagnostic redaction handles nested keys, quoted secrets, bearer and basic credentials', () => {
  const redacted = JSON.stringify(redactDiagnostic({ nested: [{ password: 'nested-secret', value: 'password="two words" api_key=fixture-value Basic Zml4dHVyZQ== Bearer fixture-value' }], apiKey: 'fixture-key' }));
  for (const secret of ['nested-secret', 'two words', 'fixture-value', 'Zml4dHVyZQ==', 'fixture-key']) assert(!redacted.includes(secret), secret);
});


test('failure journal write errors are reported without consuming or rejecting the model response', async t => {
  const { store, capture } = await fixture(t);
  await mkdir(dirname(store.path), { recursive: true }); await writeFile(store.path, 'fixture-blocks-directory');
  const req = request(); await capture.httpStart({ ...identity, request: req });
  const response = new Response('fixture unavailable', { status: 503 });
  await capture.httpResponse(req, response); assert.equal(await response.text(), 'fixture unavailable'); assert(store.error);
});

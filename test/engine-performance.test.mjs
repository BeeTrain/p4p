import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { EnginePool, defaultSettings, maskRequest, restoreValue, restoreStream, python } from '../dist/core/index.js';
import { SSEDecoder } from '../dist/core/restore.js';
import { ResponsesDecoder } from '../dist/core/ws-decoder.js';

const marker = '__P4P_0123456789abcdef01234567_0__';
const seed = { [marker]: 'reserved' };
const config = extra => ({ ...defaultSettings(), patterns: ['(?i)secret', 'user-\\d+', 'секрет🙂'], ...extra });
const engineSettings = settings => ({ enabled: settings.enabled, words: [], patterns: settings.patterns, diagnostics: settings.diagnostics });
async function reference(mode, input, wire) {
  const child = spawn(python(), ['-B', resolve('python/engine.py'), mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.resume();
  child.stdin.end(wire ?? JSON.stringify(input));
  const [code] = await once(child, 'close');
  const output = Buffer.concat(chunks).toString();
  assert.equal(code, 0, output);
  return wire === undefined ? JSON.parse(output) : output;
}
const stream = (wire, step = 256) => {
  const bytes = Buffer.from(wire);
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index >= bytes.length) controller.close();
    else { controller.enqueue(bytes.subarray(index, index + step)); index += step; }
  } });
};
const frames = wire => wire.split(/\r?\n\r?\n/).map(raw => raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(data => { try { return JSON.parse(data); } catch { return data; } });

test('schema properties named like protocol metadata restore recursively in Python, JSON and WebSocket', async () => {
  const properties = Object.fromEntries(['format', 'id', 'type', 'model', 'encrypted_content'].map(key => [key, { type: 'string', description: 'secret' }]));
  const input = { model: 'secret', tools: [{ type: 'function', function: { name: 'secret_tool', parameters: { type: 'object', properties } } }] };
  const result = await maskRequest(config(), input);
  assert.equal(result.value.model, 'secret');
  assert.deepEqual(await restoreValue(result.value, result.mapping), input);
  assert.deepEqual(await reference('restore', { value: result.value, mapping: result.mapping }), input);
  const decoder = new ResponsesDecoder(); decoder.update(result.mapping);
  assert.deepEqual(decoder.frame(result.value), input);
});

test('warm caches preserve exact values, mappings and statistics across diagnostics, scopes and rule changes', async t => {
  const pool = new EnginePool(1); t.after(() => pool.dispose());
  const text = 'secret user-42 секрет🙂\n```log\nERROR secret\n```\nTraceback (most recent call last):\n  File "secret.py", line 1\nValueError: secret\n';
  const input = { messages: [{ role: 'user', content: text }, { role: 'tool', content: text }, { role: 'assistant', content: text }] };
  for (let bits = 0; bits < 16; bits++) {
    const settings = config({ diagnostics: { logs: !!(bits & 1), stacktraces: !!(bits & 2), marked: !!(bits & 4), heuristics: !!(bits & 8), tool_output: !!(bits & 1) } });
    const expected = await reference('request', { settings: engineSettings(settings), value: input, mapping: seed });
    for (const scope of ['one', 'two', 'one']) {
      const actual = await maskRequest(settings, input, seed, pool, scope);
      assert.deepEqual(actual, expected);
      assert.deepEqual(await restoreValue(actual.value, actual.mapping), input);
    }
  }
  assert.equal(pool.statistics.starts, 1);
});

test('cached matches honor changing known markers instead of caching masked output', async t => {
  const pool = new EnginePool(1); t.after(() => pool.dispose());
  const settings = config({ patterns: ['__P4P_.*?__', 'secret'] });
  const input = { input: marker + ' secret' };
  for (const mapping of [{}, seed, {}, seed]) {
    const actual = await maskRequest(settings, input, mapping, pool, 'same-scope');
    const restored = await restoreValue(actual.value, actual.mapping);
    assert.equal(restored.input, mapping === seed ? 'reserved secret' : input.input);
    const expected = await reference('request', { settings: engineSettings(settings), value: input, mapping });
    assert.deepEqual(actual.statistics, expected.statistics);
    if (mapping === seed) assert.deepEqual(actual, expected);
  }
});

test('Python matching cache obeys byte and entry bounds, evicts and clears scopes', async () => {
  const source = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(resolve('python'))})`,
    'from engine import MatchCache, process',
    'cache = MatchCache(limit=2000, entries=2)',
    "settings = {'enabled': True, 'words': [], 'patterns': ['secret']}",
    'for index in range(10):',
    "    process(settings, {'input': 'secret ' + str(index)}, 'request', cache=cache, scope='one')",
    '    assert cache.bytes <= cache.limit and len(cache.values) <= 2',
    "assert len(cache.values) > 0",
    "cache.forget('one')",
    'assert cache.bytes == 0 and not cache.values',
    "process(settings, {'input': 'secret ' * 10000}, 'request', cache=cache, scope='two')",
    'assert cache.bytes == 0'
  ].join('\n');
  const child = spawn(python(), ['-B', '-c', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => error += chunk);
  const [code] = await once(child, 'close'); assert.equal(code, 0, error);
});

test('worker timeout rejects only the active operation, restarts and preserves queued work', async t => {
  const pool = new EnginePool(1); t.after(() => pool.dispose());
  await pool.run('validate', { settings: engineSettings(config()) });
  const bad = pool.run('request', { settings: engineSettings(config({ patterns: ['(a+)+$'] })), value: { input: 'a'.repeat(100) + '!' } }, 100);
  const good = maskRequest(config(), { input: 'secret' }, {}, pool);
  await assert.rejects(bad, /лимит/);
  const result = await good;
  assert.equal(await restoreValue(result.value.input, result.mapping), 'secret');
  assert.equal(pool.statistics.starts, 2);
});

test('worker disposal rejects active and queued work and refuses later calls', async () => {
  const pool = new EnginePool(1);
  const first = pool.run('request', { settings: engineSettings(config({ patterns: ['(a+)+$'] })), value: { input: 'a'.repeat(100) + '!' } });
  const second = maskRequest(config(), { input: 'secret' }, {}, pool);
  const settled = Promise.allSettled([first, second]);
  pool.dispose();
  assert((await settled).every(result => result.status === 'rejected' && /остановлен/.test(result.reason.message)));
  await assert.rejects(maskRequest(config(), {}, {}, pool), /остановлен/);
});

test('a blocked Python worker does not block another worker and queue capacity is bounded', async t => {
  const pool = new EnginePool(2); t.after(() => pool.dispose());
  const blocked = pool.run('request', { settings: engineSettings(config({ patterns: ['(a+)+$'] })), value: { input: 'a'.repeat(100) + '!' } }, 1000).then(() => 'blocked', () => 'blocked');
  const ready = maskRequest(config(), { input: 'secret' }, {}, pool).then(() => 'ready');
  assert.equal(await Promise.race([blocked, ready]), 'ready');
  await blocked;
  const single = new EnginePool(1); t.after(() => single.dispose());
  const active = single.run('request', { settings: engineSettings(config({ patterns: ['(a+)+$'] })), value: { input: 'a'.repeat(100) + '!' } });
  const pending = Array.from({ length: 128 }, () => maskRequest(config(), { input: 'secret' }, {}, single));
  const settled = Promise.allSettled([active, ...pending]);
  await assert.rejects(maskRequest(config(), {}, {}, single), /переполнена/);
  single.dispose();
  assert((await settled).every(result => result.status === 'rejected'));
});

test('idle Python workers stop and the pool starts again on demand', async t => {
  const pool = new EnginePool(1, 20); t.after(() => pool.dispose());
  await maskRequest(config(), { input: 'secret' }, {}, pool);
  await delay(80);
  await maskRequest(config(), { input: 'secret' }, {}, pool);
  assert.equal(pool.statistics.starts, 2);
});

test('SSE decoder matches Python for every marker split, Unicode, independent channels and terminal events', async () => {
  const mapping = { [marker]: 'секрет🙂' };
  let wire = ': heartbeat\r\n\r\n';
  for (let split = 1; split < marker.length; split++) {
    for (const part of [marker.slice(0, split), marker.slice(split)]) {
      wire += 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: part, tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null }] }) + '\r\n\r\n';
    }
  }
  wire += 'event: final\ndata: {"choices":[{"index":0,"delta":{"content":"🙂"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const expected = await reference('stream', null, JSON.stringify(mapping) + '\n' + wire);
  for (const step of [1, 7, 256, 65536]) {
    const actual = await new Response(restoreStream(stream(wire, step), mapping)).text();
    assert.deepEqual(frames(actual), frames(expected));
  }
});

test('SSE rewriting preserves numeric lexemes, event metadata, unknown markers and untouched raw frames', async () => {
  const untouched = ': ping\r\nevent: custom\r\ndata: { "sequence": 9007199254740993, "text": "unchanged" }\r\n\r\n';
  const changed = 'id: event-1\nevent: delta\ndata: {"sequence":9007199254740993,"decimal":1.2300,"negative":-0,"text":"' + marker + '"}\n\n';
  const wire = untouched + changed + 'data: {"text":"__P4P_ffffffffffffffffffffffff_9__"}\n\ndata: [DONE]\n\n';
  const actual = await new Response(restoreStream(stream(wire, 3), { [marker]: 'secret' })).text();
  assert(actual.startsWith(untouched));
  assert(actual.includes('"sequence":9007199254740993,"decimal":1.2300,"negative":-0,"text":"secret"'));
  assert(actual.includes('id: event-1\nevent: delta\n'));
  assert(actual.includes('__P4P_ffffffffffffffffffffffff_9__'));
});

test('SSE isolates lanes, flushes truncated markers at EOF and forwards complete events immediately', () => {
  const decoder = new SSEDecoder({ [marker]: 'secret' });
  const encode = value => Buffer.from('data: ' + JSON.stringify(value) + '\n\n');
  const one = decoder.feed(encode({ stream_id: 'a', delta: marker.slice(0, 12) }));
  assert.equal(one.length, 0);
  assert.equal(decoder.feed(encode({ stream_id: 'b', delta: marker })).length, 0);
  const result = frames(Buffer.from(decoder.feed(encode({ stream_id: 'a', delta: marker.slice(12) }))).toString());
  assert.equal(result[0].delta + result[2].delta, 'secret');
  assert.equal(result[1].delta, 'secret');
  assert(decoder.feed(Buffer.from(': heartbeat\n\n')).length > 0);
  assert.equal(decoder.feed(encode({ delta: '__P4P_' })).length, 0);
  assert.equal(frames(Buffer.from(decoder.feed(new Uint8Array(), true)).toString())[0].delta, '__P4P_');
});

test('SSE limits buffered events, rejects invalid UTF-8 and cancels upstream on errors', async () => {
  const decoder = new SSEDecoder({}, 64);
  assert.throws(() => decoder.feed(Buffer.from('data: ' + 'x'.repeat(65))), /лимит/);
  let cancelled = false;
  const source = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([255])); }, cancel() { cancelled = true; } });
  await assert.rejects(new Response(restoreStream(source, {})).text());
  assert.equal(cancelled, true);
});

test('restoration limits expanded output before allocating oversized strings', async () => {
  const decoder = new SSEDecoder({ [marker]: 'x'.repeat(120) }, 128);
  assert.throws(() => decoder.feed(Buffer.from('data: {"text":"' + marker + '"}\n\n')), /лимит/);
  await assert.rejects(restoreValue({ content: marker.repeat(65) }, { [marker]: 'x'.repeat(1024 * 1024) }), /слишком большой/);
});

test('expanded SSE events are emitted separately to preserve backpressure', () => {
  const decoder = new SSEDecoder({ [marker]: 'x'.repeat(80) }, 128);
  const events = Buffer.from(('data: {"text":"' + marker + '"}\n\n').repeat(2));
  const chunks = [...decoder.feedChunks(events)];
  assert.equal(chunks.length, 2);
  assert(chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 128);
  assert(chunks.every(chunk => frames(Buffer.from(chunk).toString())[0].text === 'x'.repeat(80)));
});

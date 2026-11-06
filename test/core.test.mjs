import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { defaultSettings, SettingsStore, normalizeHost, matchesHost, maskRequest, preview, restoreValue, restoreStream, MaskingTransport } from '../dist/core/index.js';

const settings = extra => ({ ...defaultSettings(), hosts: ['localhost:8080'], patterns: ['(?i)secret', 'user-\\d+'], ...extra });
const bodyStream = (text, step = 1) => {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new ReadableStream({ pull(c) { if (offset >= bytes.length) c.close(); else { c.enqueue(bytes.slice(offset, offset += step)); } } });
};
const temporary = async t => { const path = await mkdtemp(join(tmpdir(), 'batya-unit-')); t.after(() => rm(path, { recursive: true, force: true })); return path; };

test('host scope: exact, wildcard, port, IPv6, URL normalization and credentials rejection', () => {
  assert.equal(normalizeHost('HTTPS://API.Example.COM/v1'), 'api.example.com');
  assert.equal(normalizeHost('https://api.example.com:443/v1'), 'api.example.com:443');
  assert.equal(normalizeHost('*.example.com:8443'), '*.example.com:8443');
  assert.equal(normalizeHost('[::1]:8080'), '[::1]:8080');
  assert.equal(matchesHost('http://[::1]:8080/v1', ['[::1]:8080']), true);
  assert.equal(matchesHost('https://example.com', ['*.example.com']), false);
  assert.equal(matchesHost('https://x.example.com', ['*.example.com']), true);
  assert.equal(matchesHost('https://x.example.com.evil.test', ['*.example.com']), false);
  assert.equal(matchesHost('https://x.example.com', ['x.example.com:443']), true);
  assert.equal(matchesHost('https://x.example.com:8443', ['x.example.com:443']), false);
  assert.equal(matchesHost('https://x.example.com', []), false);
  for (const invalid of ['https://user:pass@example.com', '*.127.0.0.1', 'localhost/path', 'http://example.com:0', 'file:///tmp/a']) assert.throws(() => normalizeHost(invalid));
});

test('word/regex overlap, case, Unicode and local-only random mappings', async () => {
  const input = 'SECRET user-42 секрет';
  const config = settings({ patterns: ['(?i)secret', 'user-\\d+', 'секрет', 'SECR'] });
  const result = await preview(config, input);
  assert.equal(result.statistics.replacements, 3);
  assert.equal(result.restored, input);
  assert(!result.value.includes('SECRET'));
  assert(!result.value.includes(Buffer.from('SECRET').toString('hex')));
  assert.equal(await restoreValue(result.value, result.mapping), input);
  assert.equal(await restoreValue(result.value, {}), result.value);
  const again = await preview(config, input);
  assert.notEqual(result.value, again.value);
});

test('JSON protocols preserve IDs, model, image URLs; schemas and tool names roundtrip', async () => {
  const input = { model: 'secret-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'secret user-42' }, { type: 'image_url', image_url: { url: 'https://example.test/secret.png' } }] }], tools: [{ type: 'function', function: { name: 'secret_tool', description: 'secret', parameters: { type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'] } } }] };
  const result = await maskRequest(settings(), input);
  assert.equal(result.value.model, input.model);
  assert.equal(result.value.messages[0].content[1].image_url.url, input.messages[0].content[1].image_url.url);
  assert(!JSON.stringify(result.value.tools).includes('secret'));
  assert.deepEqual(await restoreValue(result.value, result.mapping), input);
});

test('log and stacktrace switches exempt detected spans, marked and heuristics', async () => {
  const config = settings();
  config.diagnostics.logs = false;
  config.diagnostics.stacktraces = false;
  const input = 'plain secret\n```log\nERROR secret\n```\njava.lang.RuntimeException: secret\n\tat example.Main.secret(Main.java:1)\n';
  const result = await preview(config, input);
  assert(result.value.includes('ERROR secret'));
  assert(result.value.includes('RuntimeException: secret'));
  assert.equal(result.statistics.replacements, 1);
  assert.equal(result.restored, input);
  config.diagnostics.logs = true; config.diagnostics.stacktraces = true;
  assert.equal((await preview(config, input)).statistics.replacements, 4);
});

test('invalid regex, empty matching and pathological regex fail with bounded time', async () => {
  await assert.rejects(preview(settings({ patterns: ['['] }), 'secret'), /Регулярное выражение 1/);
  await assert.rejects(preview(settings({ patterns: ['a*'] }), 'secret'), /пустой/);
  const started = Date.now();
  await assert.rejects(preview(settings({ patterns: ['(a+)+$'] }), 'a'.repeat(100) + '!'), /лимит/);
  assert(Date.now() - started < 8000);
});

test('SSE restores across every byte, JSON delta boundary and independent tool channels', async () => {
  const original = 'секрет🙂';
  const masked = await preview(settings({ patterns: ['секрет🙂'] }), original);
  const marker = masked.value;
  let wire = '';
  for (let i = 0; i < marker.length; i++) wire += 'data: ' + JSON.stringify({ id: 'kept', choices: [{ index: 0, delta: { content: marker[i], tool_calls: [{ index: 0, function: { arguments: marker[i] } }] }, finish_reason: null }] }) + '\n\n';
  wire += 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
  const decoded = await new Response(restoreStream(bodyStream(wire), masked.mapping)).text();
  const frames = decoded.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.equal(frames.map(f => f.choices[0].delta.content || '').join(''), original);
  assert.equal(frames.map(f => f.choices[0].delta.tool_calls?.[0].function.arguments || '').join(''), original);
  assert(decoded.includes('[DONE]'));
});

test('atomic settings, concurrent CLI updates, revision conflict and private file permissions', async t => {
  const folder = await temporary(t); const store = new SettingsStore(join(folder, 'nested', 'config.json'));
  const initial = await store.read();
  assert.deepEqual(initial.settings.patterns, []);
  await store.save(settings(), initial.revision);
  await Promise.all(['alpha', 'beta', 'gamma'].map(pattern => store.update(value => ({ ...value, patterns: [...value.patterns, pattern] }))));
  const current = await store.read();
  for (const pattern of ['alpha', 'beta', 'gamma']) assert(current.settings.patterns.includes(pattern));
  await assert.rejects(store.save(initial.settings, initial.revision), /изменились/);
  await assert.rejects(store.update(value => ({ ...value, patterns: ['['] })), /Регулярное/);
  assert.equal((await store.read()).revision, current.revision);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert(JSON.parse(await readFile(store.path, 'utf8')));
});

test('transport hot reload, host scope, auth preservation, JSON/gzip response and per-request maps', async t => {
  const folder = await temporary(t); const store = new SettingsStore(join(folder, 'config.json'));
  await store.save(settings()); const transport = new MaskingTransport(store);
  const request = () => new Request('http://localhost:8080/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer private-header' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'secret user-42' }] }) });
  const first = await transport.request(request()); const payload = await first.request.clone().json();
  assert.equal(first.request.headers.get('authorization'), 'Bearer private-header');
  const marker = payload.messages[0].content;
  assert(!marker.includes('secret'));
  await store.update(value => ({ ...value, enabled: false }));
  const unmodified = request(); assert.equal((await transport.request(unmodified)).request, unmodified);
  const restored = await transport.response(first.request, new Response(gzipSync(JSON.stringify({ choices: [{ message: { content: marker } }] })), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '999' } }));
  assert.equal((await restored.json()).choices[0].message.content, 'secret user-42');
  assert.equal(restored.headers.get('content-encoding'), null);
  await store.update(value => ({ ...value, enabled: true, hosts: ['different.test'] }));
  const outside = request(); assert.equal((await transport.request(outside)).request, outside);
  await store.update(value => ({ ...value, hosts: ['localhost:8080'] }));
  await assert.rejects(transport.checkWebSocket('ws://localhost:8080/v1'), /HTTP/);
  await transport.checkWebSocket('wss://unlisted.test/v1');
});

test('SSE transport handles fetch-decompressed gzip headers', async t => {
  const folder = await temporary(t); const store = new SettingsStore(join(folder, 'config.json')); await store.save(settings());
  const transport = new MaskingTransport(store);
  const request = (await transport.request(new Request('http://localhost:8080', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'secret' }) }))).request;
  const marker = (await request.clone().json()).input;
  const wire = 'data: ' + JSON.stringify({ choices: [{ delta: { content: marker } }] }) + '\n\ndata: [DONE]\n\n';
  const response = await transport.response(request, new Response(bodyStream(wire, 3), { headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' } }));
  assert((await response.text()).includes('secret'));
});

test('cancelling a restored stream cancels upstream and releases the Python worker', async () => {
  let cancelled = false;
  const input = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')); },
    cancel() { cancelled = true; }
  });
  const output = restoreStream(input, {});
  const reader = output.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});

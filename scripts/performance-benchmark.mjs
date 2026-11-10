import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { EnginePool, SettingsStore, defaultSettings, maskRequest, restoreValue, restoreStream, python, MaskingTransport } from '../dist/core/index.js';

const { values } = parseArgs({ options: { file: { type: 'string' }, config: { type: 'string' }, runs: { type: 'string', default: '30' }, 'reference-engine': { type: 'string' }, 'probe-pattern': { type: 'string' } } });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 3 || runs > 1000) throw new Error('Укажите от 3 до 1000 повторений.');
const row = values.file ? JSON.parse(await readFile(values.file, 'utf8')) : null;
const payload = row ? row.request ?? row : {
  model: 'local-benchmark',
  messages: Array.from({ length: 218 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message ${index}: secret user-${index} const\n` + 'synthetic unchanged history '.repeat(80) })),
  tools: [{ type: 'function', function: { name: 'fixture', parameters: { type: 'object', properties: { format: { type: 'string', description: 'secret' } } } } }]
};
const saved = values.config || row ? (await new SettingsStore(values.config).read()).settings : { ...defaultSettings(), patterns: ['(?i)secret', 'user-\\d+', ...Array.from({ length: 12 }, (_, i) => `fixture-unmatched-${i}`)] };
const settings = { ...saved, enabled: true, patterns: [...saved.patterns, ...(values['probe-pattern'] ? [values['probe-pattern']] : [])] };
const wireSettings = { enabled: true, words: [], patterns: settings.patterns, diagnostics: settings.diagnostics };
const seed = { __P4P_0123456789abcdef01234567_0__: 'benchmark reserved value' };
const referenceScript = resolve(values['reference-engine'] ?? 'python/engine.py');
async function reference(mode, input, wire) {
  const child = spawn(python(), ['-B', referenceScript, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdin.end(wire ?? JSON.stringify(input));
  try {
    const [code] = await once(child, 'close');
    if (code !== 0) throw new Error('Ошибка эталонного движка.');
    const text = Buffer.concat(chunks).toString();
    return wire === undefined ? JSON.parse(text) : text;
  } finally { clearTimeout(timer); }
}
async function measure(fn, warmup = 3) {
  const times = [];
  for (let index = 0; index < runs + warmup; index++) {
    const start = performance.now();
    await fn(index);
    if (index >= warmup) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { samples: runs, medianMs: times[Math.ceil(times.length / 2) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1] };
}
const check = (a, b, message) => { if (!isDeepStrictEqual(a, b)) throw new Error(message); };
const bufferStream = bytes => new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 256) controller.enqueue(bytes.subarray(offset, offset + 256)); controller.close(); } });
const frames = wire => wire.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(data => data === '[DONE]' ? data : JSON.parse(data));
const pool = new EnginePool(1);
const transport = new MaskingTransport({ read: async () => ({ settings: { ...settings, hosts: ['benchmark.invalid'] } }) });
try {
  const start = performance.now();
  const result = await maskRequest(settings, payload, seed, pool, 'benchmark');
  const coldMs = performance.now() - start;
  check(await restoreValue(result.value, result.mapping), payload, 'Нарушено восстановление исходного запроса.');
  const baseline = await reference('request', { settings: wireSettings, value: payload, mapping: seed });
  check(result, baseline, 'Результат или статистика отличаются от эталона.');
  const masking = {};
  masking.oneShot = await measure(() => reference('request', { settings: wireSettings, value: payload, mapping: seed }));
  masking.workerUncached = await measure(() => maskRequest(settings, payload, seed, pool));
  masking.workerCached = await measure(() => maskRequest(settings, payload, seed, pool, 'benchmark'));
  const body = JSON.stringify(payload);
  masking.transportCached = await measure(() => transport.request(new Request('https://benchmark.invalid/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), { sessionID: 'benchmark', agent: 'benchmark', model: { providerID: 'local', id: 'local' } }));
  const growing = structuredClone(payload);
  if (Array.isArray(growing.messages)) {
    masking.growingHistory = await measure(index => {
      growing.messages.push({ role: 'user', content: 'new secret user-' + index });
      return maskRequest(settings, growing, seed, pool, 'benchmark');
    });
  }
  const marker = Object.keys(result.mapping).find(key => key !== Object.keys(seed)[0]) ?? Object.keys(seed)[0];
  const response = { choices: [{ message: { role: 'assistant', content: (marker + ' ').repeat(145) + 'x'.repeat(20000) } }] };
  const jsonInput = { value: response, mapping: result.mapping };
  check(await restoreValue(response, result.mapping), await reference('restore', jsonInput), 'JSON-восстановление отличается от эталона.');
  const sse = Buffer.from(Array.from({ length: 144 }, (_, index) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: index % 2 ? marker.slice(16) : marker.slice(0, 16) }, finish_reason: null }] }) + '\n\n').join('') + 'data: [DONE]\n\n');
  const decode = () => new Response(restoreStream(bufferStream(sse), result.mapping)).text();
  check(frames(await decode()), frames(await reference('stream', null, JSON.stringify(result.mapping) + '\n' + sse.toString())), 'SSE-восстановление отличается от эталона.');
  const restoration = {
    jsonOneShot: await measure(() => reference('restore', jsonInput)),
    jsonNode: await measure(() => restoreValue(response, result.mapping)),
    sseOneShot: await measure(() => reference('stream', null, JSON.stringify(result.mapping) + '\n' + sse.toString())),
    sseNode: await measure(decode)
  };
  console.log(JSON.stringify({ machine: cpus()[0]?.model, node: process.version, runs, requestBytes: Buffer.byteLength(body), patterns: settings.patterns.length, replacements: result.statistics.replacements, jsonResponseBytes: Buffer.byteLength(JSON.stringify(response)), sseResponseBytes: sse.length, coldMs, masking, restoration, pool: pool.statistics, nodeMemory: process.memoryUsage(), integrity: 'passed' }, null, 2));
} finally { pool.dispose(); transport.dispose(); }

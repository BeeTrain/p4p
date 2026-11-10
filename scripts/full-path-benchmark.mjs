import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
  file: { type: 'string' }, config: { type: 'string' }, plugin: { type: 'string', default: '.' },
  runs: { type: 'string', default: '30' }, 'probe-pattern': { type: 'string' }, output: { type: 'string' }
} });
if (!values.file) throw new Error('Укажите --file с запросом для измерения.');
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 3 || runs > 100) throw new Error('Укажите от 3 до 100 повторений.');
const plugin = resolve(values.plugin);
const { SettingsStore, FailureStore, FailureCapture, MaskingTransport, maskRequest } = await import(pathToFileURL(join(plugin, 'dist/core/index.js')).href);
const source = JSON.parse(await readFile(values.file, 'utf8'));
const payload = source.request ?? source;
const original = await new SettingsStore(values.config).read();
const configBefore = await readFile(original.path);
const settings = { ...original.settings, enabled: true, hosts: ['benchmark.invalid'], patterns: [...original.settings.patterns, ...(values['probe-pattern'] ? [values['probe-pattern']] : [])] };
const expected = await maskRequest(settings, payload);
const firstMapping = Object.entries(expected.mapping)[0];
const expectedWord = firstMapping?.[1] ?? 'benchmark-output';
const originalMarkers = new Set(JSON.stringify(payload).match(/__P4P_[0-9a-f]{24}_[0-9]+__/g) ?? []);
const folder = await mkdtemp(join(tmpdir(), 'p4p-full-path-'));
const summary = items => {
  const sorted = [...items].sort((a, b) => a - b);
  return { medianMs: sorted[Math.ceil(sorted.length / 2) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] };
};
const digest = content => createHash('sha256').update(content).digest('hex');
const bufferStream = bytes => {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) controller.close();
    else { controller.enqueue(bytes.subarray(offset, offset + 256)); offset += 256; }
  } });
};
const cases = [];
try {
  for (const format of ['json', 'sse']) {
    const requestBody = JSON.stringify({ ...payload, stream: format === 'sse' });
    for (const recordRequests of [false, true]) {
      const config = join(folder, format + '-' + recordRequests + '.json');
      await writeFile(config, JSON.stringify({ ...settings, recordRequests }), { mode: 0o600 });
      for (const history of ['repeated', 'new-context']) {
        const store = new SettingsStore(config);
        const journal = new FailureStore(config);
        const capture = new FailureCapture(store, journal);
        const transport = new MaskingTransport(store);
        const samples = [];
        const memoryBefore = process.memoryUsage();
        let first;
        let responseBytes = 0;
        try {
          for (let index = 0; index < runs + 3; index++) {
            const identity = { sessionID: history + '-' + (history === 'repeated' ? 'same' : index), agent: 'benchmark', kind: 'primary', model: { providerID: 'local', id: 'benchmark' } };
            const request = new Request('https://benchmark.invalid/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: requestBody });
            const start = performance.now();
            const ticket = await capture.httpStart({ ...identity, request });
            const afterStart = performance.now();
            const result = await transport.request(request, identity);
            const afterMask = performance.now();
            await capture.httpSent(ticket, result.request, result.statistics);
            const afterSent = performance.now();
            if (result.statistics?.replacements !== expected.statistics.replacements) throw new Error('Статистика замен не совпала с эталоном.');
            const sentBody = await result.request.text();
            const marker = firstMapping ? [...sentBody.matchAll(/__P4P_[0-9a-f]{24}_0__/g)].map(match => match[0]).find(value => !originalMarkers.has(value)) : 'benchmark-output';
            if (!marker) throw new Error('Не найден тестовый маркер исходящего запроса.');
            const padding = 'x'.repeat(format === 'json' ? 20000 : 12000);
            const wanted = (expectedWord + ' ').repeat(72) + padding;
            const json = JSON.stringify({ choices: [{ message: { role: 'assistant', content: (marker + ' ').repeat(72) + padding }, finish_reason: 'stop' }] });
            const events = Array.from({ length: 144 }, (_, index) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: index % 2 ? marker.slice(16) + ' ' : marker.slice(0, 16) }, finish_reason: null }] }) + '\n\n').join('');
            const sse = events + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: padding }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
            const wire = Buffer.from(format === 'json' ? json : sse);
            responseBytes = wire.length;
            const response = new Response(bufferStream(wire), { headers: { 'content-type': format === 'json' ? 'application/json' : 'text/event-stream' } });
            const responseStart = performance.now();
            await capture.httpResponse(result.request, response);
            const afterHeaders = performance.now();
            const restored = await transport.response(result.request, response);
            const afterRestore = performance.now();
            const observed = capture.observe(result.request, restored);
            const reader = observed.body.getReader();
            const chunks = [];
            let firstByte;
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              firstByte ??= performance.now();
              chunks.push(chunk.value);
            }
            reader.releaseLock();
            const end = performance.now();
            if (journal.error) throw new Error('Не удалось записать тестовый журнал.');
            const text = Buffer.concat(chunks).toString();
            const content = format === 'json' ? JSON.parse(text).choices[0].message.content : text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)).choices?.[0].delta?.content ?? '').join('');
            if (content !== wanted) throw new Error('Ответ не восстановился до ожидаемого текста.');
            const sample = {
              captureStart: afterStart - start, masking: afterMask - afterStart, captureSent: afterSent - afterMask,
              requestTotal: afterSent - start, captureResponse: afterHeaders - responseStart,
              responseSetup: afterRestore - afterHeaders, firstOutput: firstByte - responseStart,
              responseTotal: end - responseStart, total: afterSent - start + end - responseStart
            };
            first ??= sample;
            if (index >= 3) samples.push(sample);
          }
          const listing = await journal.listing();
          if (listing.storage_error || recordRequests && (!listing.rows.length || listing.rows.some(row => row.status !== 'succeeded'))) throw new Error('Некорректный результат записи журнала.');
          if (!recordRequests && listing.rows.length) throw new Error('Журнал записан при отключённой записи.');
          const metrics = Object.fromEntries(Object.keys(samples[0]).map(key => [key, summary(samples.map(sample => sample[key]))]));
          const result = { format, recordRequests, history, samples: runs, requestBytes: Buffer.byteLength(requestBody), responseBytes, cold: first, metrics, journalRows: listing.rows.length, nodeMemoryBefore: memoryBefore, nodeMemoryAfter: process.memoryUsage(), integrity: 'passed' };
          cases.push(result);
          process.stderr.write(JSON.stringify({ format, recordRequests, history, requestMedianMs: metrics.requestTotal.medianMs, responseMedianMs: metrics.responseTotal.medianMs }) + '\n');
        } finally { transport.dispose(); await capture.dispose(); }
      }
    }
  }
  const configAfter = await readFile(original.path);
  if (!configAfter.equals(configBefore)) throw new Error('Рабочая конфигурация изменилась во время замера.');
  const report = {
    measuredAt: new Date().toISOString(), machine: cpus()[0]?.model, node: process.version, plugin,
    engineHash: digest(await readFile(join(plugin, 'dist/core/engine-pool.js'))), patterns: settings.patterns.length,
    replacements: expected.statistics.replacements, settingsUnchanged: true, cases,
    scope: 'Installed plugin hook pipeline, real settings reads and journal disk writes; response prepared locally; excludes provider/network and Desktop rendering',
    integrity: 'passed'
  };
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(folder, { recursive: true, force: true }); }

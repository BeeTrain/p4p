import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse } from 'jsonc-parser';
import { hash, schedule, payloadFor, sourceHash, validateScenario } from './cache-benchmark/scenario.mjs';
import { analyze, renderReport } from './cache-benchmark/analysis.mjs';
import { prepareResume } from './cache-benchmark/resume.mjs';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const expand = path => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const integer = (value, min, max, name) => { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Параметр ${name}: целое число от ${min} до ${max}.`); return number; };
const parsed = parseArgs({ options: {
  model: { type: 'string' }, 'opencode-config': { type: 'string' }, 'p4p-config': { type: 'string' }, plugin: { type: 'string' },
  scenario: { type: 'string' }, pairs: { type: 'string', default: '10' }, requests: { type: 'string', default: '20' },
  'interval-ms': { type: 'string', default: '5000' }, 'global-interval-ms': { type: 'string', default: '2500' },
  'max-output-tokens': { type: 'string', default: '96' }, 'margin-pp': { type: 'string', default: '5' },
  seed: { type: 'string', default: 'p4p-cache-ab-v1' }, output: { type: 'string' }, analyze: { type: 'string' }, resume: { type: 'string' },
  'max-consecutive-errors': { type: 'string', default: '3' },
  'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, worker: { type: 'boolean', default: false }
} }).values;

async function loadRuntime(options) {
  const configFile = expand(options['opencode-config'] ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode/opencode.jsonc'));
  const configText = await readFile(configFile, 'utf8');
  const errors = [];
  const config = parse(configText, errors);
  assert.equal(errors.length, 0, 'Некорректный JSONC OpenCode.');
  const selected = options.model ?? config.model;
  assert(typeof selected === 'string' && selected.includes('/'), 'Укажите --model provider/model.');
  const separator = selected.indexOf('/');
  const providerID = selected.slice(0, separator), model = selected.slice(separator + 1);
  const provider = config.provider?.[providerID];
  assert(provider?.models?.[model], 'Модель отсутствует в выбранной конфигурации OpenCode.');
  const endpoint = new URL(provider.options.baseURL.replace(/\/$/, '') + '/chat/completions').toString();
  assert(['http:', 'https:'].includes(new URL(endpoint).protocol));
  let credential = provider.options.apiKey;
  if (typeof credential === 'string' && /^\{env:[^}]+\}$/.test(credential)) credential = process.env[credential.slice(5, -1)];
  assert(typeof credential === 'string' && credential.length > 0, 'Нужен apiKey провайдера или доступная ссылка {env:NAME}.');
  const entry = config.plugins?.find(item => typeof item?.package === 'string' && /(?:^|\/)p4p\/?$/.test(item.package));
  const pluginRoot = expand(options.plugin ?? (entry && isAbsolute(entry.package) ? entry.package : root));
  const core = await import(pathToFileURL(join(pluginRoot, 'dist/core/index.js')).href);
  const explicitSettings = options['p4p-config'] ?? entry?.options?.config;
  const store = new core.SettingsStore(explicitSettings ? expand(explicitSettings) : undefined);
  const settingsText = await readFile(store.path, 'utf8');
  const view = await store.read();
  assert(view.settings.enabled && view.settings.patterns.length && core.matchesHost(endpoint, view.settings.hosts), 'Для выбранной модели p4p не включён или хост не выбран. Укажите подходящую модель, сохранив рабочие настройки.');
  const scenarioPath = expand(options.scenario ?? join(root, 'scripts/cache-benchmark/scenario.json'));
  const scenario = validateScenario(JSON.parse(await readFile(scenarioPath, 'utf8')));
  const pluginFiles = ['package.json', 'dist/core/transport.js', 'dist/core/engine.js', 'dist/core/settings.js', 'python/engine.py', 'python/diagnostic_fragments.py'];
  const codeHash = async () => hash(await Promise.all(pluginFiles.map(async file => [file, hash((await readFile(join(pluginRoot, file))).toString('base64'))])));
  const pluginCodeHash = await codeHash();
  const packageInfo = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
  const metadata = { provider: providerID, model, endpoint, configFile, configSha256: hash(configText), settingsPath: store.path, settingsSha256: hash(settingsText), settingsRevision: view.revision, patternCount: view.settings.patterns.length, pluginRoot, pluginVersion: packageInfo.version, pluginCodeHash, scenarioPath, scenarioHash: hash(scenario) };
  const assertUnchanged = async () => {
    assert.equal((await store.read()).revision, view.revision, 'Настройки p4p изменились во время теста.');
    assert.equal(hash(await readFile(configFile, 'utf8')), metadata.configSha256, 'Конфигурация OpenCode изменилась во время теста.');
    assert.equal(await codeHash(), pluginCodeHash, 'Код плагина изменился во время теста.');
  };
  const secretValues = [credential, ...Object.values(provider.options.headers ?? {}).filter(value => typeof value === 'string')];
  const redact = value => secretValues.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, String(value));
  return { ...metadata, metadata, core, store, scenario, credential, provider, assertUnchanged, redact };
}

function makeExecutor(runtime, mode) {
  const transport = mode === 'masked' ? new runtime.core.MaskingTransport(runtime.store) : undefined;
  const contexts = new Map();
  return {
    async execute({ plan, pair, turn, preflight = false }) {
      await runtime.assertUnchanged();
      const nonce = pair.prefixes[mode];
      const identity = { sessionID: `${plan.runID}:${pair.id}`, agent: 'build', model: { providerID: runtime.metadata.provider, id: runtime.model }, kind: 'primary' };
      const payload = payloadFor(runtime.scenario, runtime.model, nonce, turn, plan.maxOutputTokens);
      const sourceSha256 = sourceHash(runtime.scenario, runtime.model, turn, plan.maxOutputTokens);
      const original = new Request(runtime.endpoint, { method: 'POST', headers: { ...runtime.provider.options.headers, authorization: 'Bearer ' + runtime.credential, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const totalStart = performance.now();
      const maskingStart = performance.now();
      const outgoing = transport ? await transport.request(original, identity) : { request: original };
      const maskingMs = Math.round(performance.now() - maskingStart);
      const text = await outgoing.request.clone().text();
      const wire = JSON.parse(text);
      const instructionsSha256 = hash(wire.messages[0].content), toolsSha256 = hash(wire.tools ?? []);
      const previous = contexts.get(pair.id);
      const entry = { pair: pair.id, mode, turn, startedAt: new Date().toISOString(), sourceSha256, bodySha256: hash(text), instructionsSha256, toolsSha256, instructionsChars: wire.messages[0].content.length, firstMarkerOffset: wire.messages[0].content.indexOf('__P4P_'), requestBytes: Buffer.byteLength(text), replacements: outgoing.statistics?.replacements ?? 0, maskingMs, integrityOK: true };
      if (previous) {
        assert.equal(instructionsSha256, previous.instructionsSha256, 'Системные инструкции меняются внутри сессии.');
        assert.equal(toolsSha256, previous.toolsSha256, 'Описания инструментов меняются внутри сессии.');
        assert.equal(hash(wire.messages.slice(0, previous.messages.length)), hash(previous.messages), 'Ранее отправленная история изменилась.');
      }
      if (transport) assert(outgoing.statistics?.replacements > 0, 'Сценарий не содержит совпадений с текущими правилами. Подготовьте синтетический сценарий для вашего словаря.');
      contexts.set(pair.id, { messages: wire.messages, instructionsSha256, toolsSha256 });
      if (preflight) return entry;
      try {
        const fetchStart = performance.now();
        const response = await fetch(outgoing.request.clone(), { signal: AbortSignal.timeout(60000) });
        entry.status = response.status;
        const raw = await response.clone().json();
        entry.upstreamMs = Math.round(performance.now() - fetchStart);
        if (response.ok) {
          const restored = transport ? await transport.response(outgoing.request, response) : response;
          const value = await restored.json();
          const usage = raw.usage ?? {};
          entry.inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? null;
          entry.cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? null;
          entry.outputTokens = usage.completion_tokens ?? usage.output_tokens ?? null;
          entry.responseModel = raw.model;
          entry.responsePresent = Boolean(value.choices?.[0]?.message);
          entry.usage = usage;
        } else entry.error = runtime.redact(raw.error?.message ?? 'Ошибка провайдера');
      } catch (error) { entry.error = runtime.redact(error); entry.errorCode = error.cause?.code ?? error.code ?? null; }
      entry.totalMs = Math.round(performance.now() - totalStart);
      await runtime.assertUnchanged();
      return entry;
    },
    remove(pair, plan) { contexts.delete(pair.id); transport?.remove(`${plan.runID}:${pair.id}`); },
    dispose() { transport?.dispose(); contexts.clear(); }
  };
}

async function workerMain() {
  let runtime, executor;
  let queue = Promise.resolve();
  process.on('message', message => {
    queue = queue.then(async () => {
      try {
        let value;
        if (message.type === 'init') { runtime = await loadRuntime(message.options); executor = makeExecutor(runtime, message.mode); value = runtime.metadata; }
        else if (message.type === 'execute') value = await executor.execute(message.payload);
        else if (message.type === 'remove') { executor.remove(message.pair, message.plan); value = true; }
        else if (message.type === 'check') { await runtime.assertUnchanged(); value = true; }
        else throw new Error('Неизвестная команда рабочего процесса.');
        process.send?.({ id: message.id, value });
      } catch (error) { process.send?.({ id: message.id, error: runtime ? runtime.redact(error) : 'Не удалось подготовить рабочий процесс: ' + String(error.message) }); }
    });
  });
  process.on('disconnect', () => { executor?.dispose(); process.exit(0); });
}

function startWorker() {
  const child = fork(script, ['--worker'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map();
  let nextID = 0;
  child.stdout.resume(); child.stderr.resume();
  child.on('message', message => {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id); clearTimeout(operation.timer);
    message.error ? operation.reject(new Error(message.error)) : operation.resolve(message.value);
  });
  child.on('exit', code => { for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('Рабочий процесс завершился: ' + code)); } pending.clear(); });
  return {
    call(type, payload = {}) { return new Promise((resolve, reject) => { const id = ++nextID; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Истёк лимит рабочего процесса.')); }, 75000); pending.set(id, { resolve, reject, timer }); child.send({ id, type, ...payload }); }); },
    stop() { if (child.connected) child.disconnect(); }
  };
}

async function loadRows(directory) {
  const text = await readFile(join(directory, 'requests.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function saveAnalysis(directory, plan, rows, samples = 20000) {
  const result = analyze(plan, rows, samples);
  await writeFile(join(directory, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'REPORT.md'), renderReport(plan, result), { mode: 0o600 });
  return result;
}

async function main(options) {
  if (options.help) {
    console.log('node scripts/cache-benchmark.mjs --model provider/model [--pairs 10 --requests 20 --plugin PATH --p4p-config FILE --opencode-config FILE --scenario FILE --interval-ms 5000 --global-interval-ms 2500 --margin-pp 5 --seed TEXT --output DIR --dry-run]\nnode scripts/cache-benchmark.mjs --analyze DIR\nnode scripts/cache-benchmark.mjs --resume DIR [--p4p-config MATCHING_SNAPSHOT --dry-run]\nПолная методика: scripts/cache-benchmark/README.md');
    return;
  }
  if (options.analyze) {
    const directory = expand(options.analyze);
    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
    const result = await saveAnalysis(directory, plan, await loadRows(directory));
    console.log(JSON.stringify({ stage: 'analyzed', directory, verdict: result.verdict, difference: result.warmHitDifference, ci95: result.warmHitDifferenceCI95 }));
    return;
  }
  let previous;
  if (options.resume) {
    const directory = expand(options.resume);
    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
    let settingsFile = options['p4p-config'];
    if (!settingsFile) {
      for (const candidate of [plan.settingsPath, plan.sourceSettingsPath]) {
        if (!candidate) continue;
        try { if (hash(await readFile(candidate, 'utf8')) === plan.settingsSha256) { settingsFile = candidate; break; } } catch {}
      }
    }
    assert(settingsFile, 'Не найдена исходная копия настроек. Укажите --p4p-config с копией, совпадающей с планом.');
    options = { ...options, model: `${plan.provider}/${plan.model}`, plugin: plan.pluginRoot, scenario: plan.scenarioPath, 'opencode-config': plan.configFile, 'p4p-config': settingsFile };
    previous = { plan, rows: await loadRows(directory), directory };
  }
  const original = await loadRuntime(options);
  const snapshotDirectory = await mkdtemp(join(tmpdir(), 'p4p-cache-benchmark-'));
  const snapshotFile = join(snapshotDirectory, 'settings.json');
  const state = { live: false };
  let completed = false;
  try {
    const contents = await readFile(original.store.path, 'utf8');
    assert.equal(hash(contents), original.settingsSha256, 'Настройки изменились во время создания копии.');
    await writeFile(snapshotFile, contents, { mode: 0o600 });
    await runBenchmark({ ...options, 'p4p-config': snapshotFile }, previous ? { sourceSettingsPath: previous.plan.sourceSettingsPath, sourceSettingsSha256: previous.plan.sourceSettingsSha256, sourceSettingsRevision: previous.plan.sourceSettingsRevision, settingsFrozen: true } : { sourceSettingsPath: original.store.path, sourceSettingsSha256: hash(contents), sourceSettingsRevision: original.settingsRevision, settingsFrozen: true }, previous, state);
    completed = true;
  } finally { if (completed || !state.live) await rm(snapshotDirectory, { recursive: true, force: true }); }
}

async function runBenchmark(options, snapshot, previous, state) {
  const runtime = await loadRuntime(options);
  const runID = randomUUID();
  const pairs = previous?.plan.pairs.length ?? integer(options.pairs, 2, 100, '--pairs');
  const requests = previous?.plan.requests ?? integer(options.requests, 2, 100, '--requests');
  const marginPP = previous?.plan.marginPP ?? Number(options['margin-pp']);
  assert(Number.isFinite(marginPP) && marginPP > 0 && marginPP <= 100, 'Неверный --margin-pp.');
  const directory = previous?.directory ?? expand(options.output ?? join(root, 'test-results/cache-benchmark', new Date().toISOString().replace(/[:.]/g, '-') + '-' + runID.slice(0, 8)));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resumed = previous ? prepareResume(previous.plan, previous.rows, runtime.metadata) : undefined;
  const plan = resumed?.plan ?? { version: 1, runID, startedAt: new Date().toISOString(), ...runtime.metadata, ...snapshot, seed: options.seed, requests, marginPP, intervalMs: integer(options['interval-ms'], 0, 60000, '--interval-ms'), globalIntervalMs: integer(options['global-interval-ms'], 0, 60000, '--global-interval-ms'), maxOutputTokens: integer(options['max-output-tokens'], 16, 4096, '--max-output-tokens'), plannedCalls: pairs * requests * 2, primaryAnalysis: 'post-first-request paired session bootstrap', bootstrapSamples: 20000, dryRun: options['dry-run'], pairs: Array.from({ length: pairs }, (_, index) => ({ id: index + 1, prefixes: { raw: randomUUID(), masked: randomUUID() }, order: schedule(requests, options.seed + ':pair:' + (index + 1)) })) };
  plan.maxConsecutiveErrors ??= integer(options['max-consecutive-errors'], 1, 20, '--max-consecutive-errors');
  const keptPairs = new Set(resumed?.keptPairs ?? []);
  const planPath = join(directory, 'plan.json');
  const savePlan = () => writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
  if (!previous) await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const preflight = makeExecutor(runtime, 'masked');
  try {
    const checks = [];
    for (let turn = 1; turn <= 3; turn++) checks.push(await preflight.execute({ plan: { ...plan, runID: 'preflight:' + runID }, pair: plan.pairs.find(pair => !keptPairs.has(pair.id)) ?? plan.pairs[0], turn, preflight: true }));
    if (!options['dry-run'] || !previous) await writeFile(join(directory, previous ? 'preflight-resume.json' : 'preflight.json'), JSON.stringify(checks, null, 2) + '\n', { mode: 0o600 });
  } finally { preflight.dispose(); }
  console.log(JSON.stringify({ stage: 'plan', directory, calls: plan.plannedCalls, remainingCalls: (pairs - keptPairs.size) * requests * 2, keptPairs: [...keptPairs], pairs, requests, model: `${plan.provider}/${plan.model}`, settingsRevision: plan.settingsRevision, plugin: plan.pluginRoot, dryRun: options['dry-run'] }));
  if (options['dry-run']) return;
  if (previous) {
    const archive = join(directory, 'attempts', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await writeFile(join(archive, 'plan.json'), JSON.stringify(previous.plan, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(archive, 'requests.jsonl'), previous.rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    plan.resumes = [...(plan.resumes ?? []), { at: new Date().toISOString(), archive, keptPairs: [...keptPairs], restartedPairs: resumed.pendingPairs, excludedRows: resumed.archivedRows }];
    await writeFile(join(directory, 'requests.jsonl'), resumed.keptRows.map(row => JSON.stringify(row)).join('\n') + (resumed.keptRows.length ? '\n' : ''), { mode: 0o600 });
    await savePlan();
  }
  state.live = true;
  const workers = { raw: startWorker(), masked: startWorker() };
  const rows = [...(resumed?.keptRows ?? [])];
  const lastStart = { raw: 0, masked: 0 };
  let globalLastStart = 0;
  let consecutiveErrors = 0;
  try {
    for (const [mode, worker] of Object.entries(workers)) assert.deepEqual(await worker.call('init', { options, mode }), runtime.metadata, 'Рабочие процессы получили разные конфигурации.');
    for (const pair of plan.pairs) {
      if (keptPairs.has(pair.id)) continue;
      console.log(JSON.stringify({ stage: 'pair-start', pair: pair.id, of: pairs, completedCalls: rows.length }));
      for (let turn = 1; turn <= requests; turn++) {
        const step = [];
        for (const mode of pair.order[turn - 1]) {
          const due = Math.max(lastStart[mode] + plan.intervalMs, globalLastStart + plan.globalIntervalMs);
          if (due > Date.now()) await pause(due - Date.now());
          lastStart[mode] = globalLastStart = Date.now();
          const row = await workers[mode].call('execute', { payload: { plan, pair, turn } });
          rows.push(row); step.push(row);
          await appendFile(join(directory, 'requests.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
          if ([400, 401, 403, 404].includes(row.status)) throw new Error(`Провайдер отклонил запрос HTTP ${row.status}: ${row.error ?? ''}`);
          if (row.status === 200 && (!Number.isFinite(row.cachedTokens) || !Number.isFinite(row.inputTokens) || !row.responsePresent)) throw new Error('Провайдер не вернул корректный ответ с метриками кеша. Тест остановлен.');
          consecutiveErrors = row.status === 200 ? 0 : consecutiveErrors + 1;
          if (consecutiveErrors >= plan.maxConsecutiveErrors) throw new Error(`Тест остановлен после ${consecutiveErrors} последовательных ошибок: ${row.errorCode ?? row.status ?? row.error}. Восстановите доступ к провайдеру и используйте --resume.`);
        }
        assert.equal(step[0].sourceSha256, step[1].sourceSha256, 'Исходные сценарии режимов различаются.');
        if (turn % 5 === 0 || turn === requests) console.log(JSON.stringify({ stage: 'progress', pair: pair.id, turn, completedCalls: rows.length, totalCalls: plan.plannedCalls, hits: { masked: rows.filter(row => row.mode === 'masked' && row.cachedTokens > 0).length, raw: rows.filter(row => row.mode === 'raw' && row.cachedTokens > 0).length } }));
      }
      for (const worker of Object.values(workers)) await worker.call('remove', { pair, plan });
      const interim = await saveAnalysis(directory, plan, rows, 2000);
      console.log(JSON.stringify({ stage: 'pair-complete', pair: pair.id, pairResult: interim.pairs[pair.id - 1] }));
    }
    for (const worker of Object.values(workers)) await worker.call('check');
    await runtime.assertUnchanged();
    plan.finishedAt = new Date().toISOString();
    plan.settingsUnchanged = true;
    const originalContents = await readFile(snapshot.sourceSettingsPath, 'utf8').catch(() => null);
    plan.sourceSettingsChangedDuringRun = originalContents === null ? 'unavailable' : hash(originalContents) !== snapshot.sourceSettingsSha256;
    delete plan.error;
    plan.completed = true;
    await savePlan();
    const result = await saveAnalysis(directory, plan, rows);
    console.log(JSON.stringify({ stage: 'complete', directory, verdict: result.verdict, masked: result.masked, raw: result.raw, difference: result.warmHitDifference, ci95: result.warmHitDifferenceCI95, tokenIncrease: result.inputTokenIncrease }));
  } catch (error) {
    plan.completed = false;
    plan.error = runtime.redact(error);
    await savePlan();
    await saveAnalysis(directory, plan, rows);
    throw error;
  } finally { for (const worker of Object.values(workers)) worker.stop(); }
}

if (parsed.worker) await workerMain();
else await main(parsed).catch(error => { console.error(error.message); process.exitCode = 1; });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { schedule, payloadFor, sourceHash, validateScenario } from '../scripts/cache-benchmark/scenario.mjs';
import { metrics, analyze, bootstrapPairs } from '../scripts/cache-benchmark/analysis.mjs';
import { prepareResume } from '../scripts/cache-benchmark/resume.mjs';

const scenario = validateScenario(JSON.parse(await readFile(new URL('../scripts/cache-benchmark/scenario.json', import.meta.url), 'utf8')));
const plan = { pairs: [{ id: 1 }, { id: 2 }], requests: 3, seed: 'fixture', marginPP: 5 };
const row = (pair, mode, turn, cachedTokens) => ({ pair, mode, turn, status: 200, inputTokens: 2000, cachedTokens, sourceSha256: 'source:' + turn, instructionsSha256: `${pair}:${mode}`, toolsSha256: 'tools', integrityOK: true });
const fixture = (a, b) => plan.pairs.flatMap(({ id }) => ['masked', 'raw'].flatMap(mode => [1, 2, 3].map(turn => row(id, mode, turn, turn === 1 ? 0 : (mode === 'masked' ? a : b)))));

test('benchmark replays the exact earlier history, stable tools and independent prefixes', () => {
  const first = payloadFor(scenario, 'model', 'nonce-a', 1);
  const later = payloadFor(scenario, 'model', 'nonce-a', 3);
  assert.deepEqual(later.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(later.tools, first.tools);
  assert.equal(later.messages[2].content, 'OK');
  assert.equal(later.messages.length, 6);
  assert.notEqual(payloadFor(scenario, 'model', 'nonce-b', 1).messages[0].content, first.messages[0].content);
  assert.equal(sourceHash(scenario, 'model', 3, 96), sourceHash(scenario, 'model', 3, 96));
  assert.notEqual(sourceHash(scenario, 'model', 2, 96), sourceHash(scenario, 'model', 3, 96));
});

test('benchmark schedule is reproducible, balanced and always contains both modes', () => {
  const a = schedule(20, 'one');
  assert.deepEqual(a, schedule(20, 'one'));
  assert.notDeepEqual(a, schedule(20, 'two'));
  assert.equal(a.filter(order => order[0] === 'raw').length, 10);
  assert(a.every(order => new Set(order).size === 2 && order.includes('masked') && order.includes('raw')));
});

test('benchmark separates first requests, missing usage and failed attempts', () => {
  const result = metrics([row(1, 'raw', 1, 1000), row(1, 'raw', 2, 0), row(1, 'raw', 3, null), { ...row(1, 'raw', 4, 0), status: 503 }]);
  assert.equal(result.attempted, 4);
  assert.equal(result.measured, 2);
  assert.equal(result.hits, 1);
  assert.equal(result.coldHits, 1);
  assert.equal(result.warmHits, 0);
  assert.equal(result.cachedTokenShare, 0.25);
});

test('paired analysis recognizes equivalence, large differences and an uninformative all-miss test', () => {
  const same = analyze(plan, fixture(1000, 1000), 1000);
  assert.equal(same.verdict, 'within-margin');
  assert.equal(same.warmHitDifference, 0);
  assert.equal(same.warmHitDifferenceCI95.low, 0);
  assert.equal(analyze(plan, fixture(0, 0), 1000).verdict, 'insufficient-cache-observations');
  assert.equal(analyze(plan, fixture(0, 1000), 1000).verdict, 'masked-worse-than-margin');
  const worse = fixture(1000, 1000).map(item => item.mode === 'masked' && item.turn === 2 ? { ...item, cachedTokens: 0 } : item);
  assert.equal(analyze(plan, worse, 1000).verdict, 'masked-worse-than-margin');
  const better = fixture(1000, 1000).map(item => item.mode === 'raw' && item.turn === 2 ? { ...item, cachedTokens: 0 } : item);
  assert.equal(analyze(plan, better, 1000).verdict, 'masked-better-than-margin');
});

test('paired analysis excludes whole incomplete or unstable sessions', () => {
  const missing = fixture(1000, 1000).filter(item => !(item.pair === 1 && item.mode === 'raw' && item.turn === 2));
  const partial = analyze(plan, missing, 1000);
  assert.equal(partial.usablePairs, 1);
  assert.equal(partial.verdict, 'incomplete');
  const unstable = fixture(1000, 1000).map(item => item.pair === 1 && item.mode === 'masked' && item.turn === 3 ? { ...item, instructionsSha256: 'changed' } : item);
  assert.equal(analyze(plan, unstable, 1000).usablePairs, 1);
  const differentSources = fixture(1000, 1000).map(item => item.pair === 1 && item.mode === 'masked' && item.turn === 3 ? { ...item, sourceSha256: 'different' } : item);
  assert.equal(analyze(plan, differentSources, 1000).usablePairs, 1);
});

test('bootstrap resamples whole paired differences reproducibly', () => {
  const interval = bootstrapPairs([-0.2, 0, 0.2], 'seed', 2000);
  assert.deepEqual(interval, bootstrapPairs([-0.2, 0, 0.2], 'seed', 2000));
  assert(interval.low < 0 && interval.high > 0);
  assert(interval.low >= -0.2 - 1e-12 && interval.high <= 0.2 + 1e-12);
  assert.equal(bootstrapPairs([0.1], 'seed'), null);
});

test('resume keeps complete pairs and replaces both prefixes of incomplete pairs', () => {
  const previous = { ...plan, provider: 'provider', model: 'model', endpoint: 'https://fixture.test/v1/chat/completions', configSha256: 'config', settingsSha256: 'settings', settingsRevision: 'revision', pluginCodeHash: 'code', scenarioHash: 'scenario', settingsPath: 'old-copy', pairs: plan.pairs.map(pair => ({ ...pair, prefixes: { raw: 'raw-' + pair.id, masked: 'masked-' + pair.id } })) };
  const metadata = { ...previous, settingsPath: 'new-copy' };
  const rows = fixture(1000, 1000).filter(item => item.pair === 1 || item.turn === 1);
  let index = 0;
  const result = prepareResume(previous, rows, metadata, () => 'fresh-' + ++index);
  assert.deepEqual(result.keptPairs, [1]);
  assert.deepEqual(result.pendingPairs, [2]);
  assert.equal(result.keptRows.length, 6);
  assert.equal(result.archivedRows, 2);
  assert.deepEqual(result.plan.pairs[0].prefixes, previous.pairs[0].prefixes);
  assert.deepEqual(result.plan.pairs[1].prefixes, { raw: 'fresh-1', masked: 'fresh-2' });
  assert.equal(result.plan.settingsPath, 'new-copy');
  assert.equal(previous.settingsPath, 'old-copy');
  assert.throws(() => prepareResume(previous, rows, { ...metadata, pluginCodeHash: 'changed' }), /pluginCodeHash/);
});

test('CLI dry run sends no requests and protects the output of an earlier run', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-benchmark-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settingsPath = join(folder, 'p4p.json'), configPath = join(folder, 'opencode.jsonc'), output = join(folder, 'report');
  await writeFile(settingsPath, JSON.stringify({ version: 1, enabled: true, patterns: ['(?i)\\bauth\\b'], hosts: ['fixture.test'] }));
  await writeFile(configPath, JSON.stringify({ provider: { fixture: { options: { baseURL: 'https://fixture.test/v1', apiKey: 'synthetic-fixture-credential' }, models: { model: {} } } } }));
  const args = ['scripts/cache-benchmark.mjs', '--model', 'fixture/model', '--opencode-config', configPath, '--p4p-config', settingsPath, '--plugin', resolve('.'), '--pairs', '2', '--requests', '3', '--output', output, '--dry-run'];
  const call = promisify(execFile);
  await call(process.execPath, args);
  const saved = await readFile(join(output, 'plan.json'), 'utf8');
  const savedPlan = JSON.parse(saved);
  const preflight = JSON.parse(await readFile(join(output, 'preflight.json'), 'utf8'));
  assert.equal(preflight.length, 3);
  assert(preflight.every(item => item.replacements > 0 && item.status === undefined));
  await assert.rejects(readFile(join(output, 'requests.jsonl')), { code: 'ENOENT' });
  assert(!saved.includes('synthetic-fixture-credential'));
  assert.equal(savedPlan.sourceSettingsPath, settingsPath);
  assert.equal(savedPlan.settingsFrozen, true);
  assert.notEqual(savedPlan.settingsPath, settingsPath);
  await assert.rejects(readFile(savedPlan.settingsPath), { code: 'ENOENT' });
  await assert.rejects(call(process.execPath, args), /EEXIST/);
  assert.equal(await readFile(join(output, 'plan.json'), 'utf8'), saved);
  await writeFile(join(output, 'requests.jsonl'), fixture(1000, 1000).filter(item => item.pair === 1).map(item => JSON.stringify(item)).join('\n') + '\n');
  const resumed = await call(process.execPath, [...args, '--resume', output]);
  const summary = JSON.parse(resumed.stdout.trim());
  assert.equal(summary.remainingCalls, 6);
  assert.deepEqual(summary.keptPairs, [1]);
  assert.equal(await readFile(join(output, 'plan.json'), 'utf8'), saved);
});

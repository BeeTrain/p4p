import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings, parseConfig, serializeConfig, CONFIG_LIMIT_BYTES } from '../dist/core/index.js';
const exec = promisify(execFile);
const sample = () => ({ ...defaultSettings(), enabled: false, recordRequests: false, requestLogFilter: 'failed', hosts: ['api.example.test', '*.models.example.test:443'], patterns: ['(?i)private', 'user-\\d+', 'секрет'], diagnostics: { logs: false, stacktraces: true, marked: false, heuristics: true, tool_output: true } });

test('configuration roundtrip preserves every setting and excludes source-machine metadata', async () => {
  const settings = sample();
  const file = await serializeConfig({ ...settings, path: '/machine/config', revision: 'revision', mapping: { opaque: 'private' } });
  assert.equal(file.name, 'p4p-config.json');
  assert.deepEqual(JSON.parse(file.content), settings);
  assert.deepEqual(await parseConfig(file.content), settings);
  assert.deepEqual(await parseConfig('\uFEFF' + file.content), settings);
  assert.deepEqual(await parseConfig(JSON.stringify({ settings, path: '/other-machine/config', revision: 'untrusted' })), settings);
});

test('legacy word dictionaries are normalized and invalid or oversized imports are rejected', async () => {
  const imported = await parseConfig(JSON.stringify({ enabled: true, words: ['literal.value'] }));
  assert.deepEqual(imported.patterns, ['(?i)literal\\.value']);
  assert.equal(imported.recordRequests, true);
  assert.equal(imported.requestLogFilter, 'all');
  for (const requestLogFilter of ['all', 'succeeded', 'failed']) {
    const settings = { ...sample(), requestLogFilter };
    assert.deepEqual(await parseConfig((await serializeConfig(settings)).content), settings);
  }
  for (const requestLogFilter of ['unknown', '', true, 0, null, {}]) await assert.rejects(parseConfig(JSON.stringify({ ...sample(), requestLogFilter })), /режим записи запросов/);
  await assert.rejects(parseConfig(JSON.stringify({ ...sample(), recordRequests: 'yes' })), /записи запросов/);
  await assert.rejects(parseConfig('{'), /корректный JSON/);
  await assert.rejects(parseConfig(JSON.stringify({ ...sample(), version: 100 })), /версия/);
  await assert.rejects(parseConfig(JSON.stringify({ ...sample(), patterns: ['['] })), /Регулярное выражение/);
  await assert.rejects(parseConfig(JSON.stringify({ ...sample(), hosts: ['https://user:pass@example.test'] })), /учётных/);
  await assert.rejects(parseConfig(' '.repeat(CONFIG_LIMIT_BYTES + 1)), /8 МБ/);
  await assert.rejects(serializeConfig({ ...sample(), patterns: ['a*'] }), /пустой/);
});

test('CLI exports portable JSON, imports files or stdin, protects exports and preserves settings on failures', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-config-cli-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const source = join(folder, 'source.json'), destination = join(folder, 'destination.json'), output = join(folder, 'backup.json');
  const settings = sample(); await writeFile(source, JSON.stringify(settings));
  const cli = async (config, ...args) => (await exec(process.execPath, [resolve('dist/cli.js'), '--config', config, ...args])).stdout;
  const raw = await cli(source, 'export'); assert.deepEqual(JSON.parse(raw), settings);
  assert.deepEqual(JSON.parse(await cli(source, '--json', 'config', 'export', '-')), settings);
  await cli(source, 'export', output); assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(cli(source, 'export', output), /уже существует/); assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), settings);
  await cli(source, 'export', '--force', output);
  await assert.rejects(cli(source, 'export', '--force', source), /отдельный файл/);
  const alias = join(folder, 'alias'); await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cli(source, 'export', '--force', join(alias, 'source.json')), /отдельный файл/);
  await cli(destination, 'import', '--file', output); assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), settings);
  const before = await readFile(destination, 'utf8');
  await writeFile(output, JSON.stringify({ ...settings, patterns: ['['] }));
  await assert.rejects(cli(destination, 'config', 'import', output), /Регулярное выражение/);
  assert.equal(await readFile(destination, 'utf8'), before);
  const changed = { ...settings, enabled: true };
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), '--config', destination, 'import', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolveResult(stdout) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(changed));
  });
  assert.deepEqual(JSON.parse(result).settings, changed); assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), changed);
});

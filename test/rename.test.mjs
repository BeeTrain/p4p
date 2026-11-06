import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from '../dist/core/index.js';
const exec = promisify(execFile);
const cli = resolve('dist/cli.js');
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-rename-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = { ...process.env, XDG_CONFIG_HOME: folder };
  for (const key of ['P4P_CONFIG', 'BATYA_CONFIG', 'P4P_PYTHON', 'BATYA_PYTHON']) delete env[key];
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, '--json', ...args], { env })).stdout);
  return { folder, env, run };
}

test('p4p preserves legacy settings until first save, then uses the new file', async t => {
  const { folder, run } = await fixture(t);
  const oldFile = join(folder, 'batya', 'config.json'); await mkdir(join(folder, 'batya'));
  const settings = { ...defaultSettings(), patterns: ['(?i)private'], hosts: ['api.example.test'] };
  await writeFile(oldFile, JSON.stringify(settings));
  const before = await readFile(oldFile, 'utf8');
  const initial = await run('status');
  assert.deepEqual(initial.settings, settings); assert.equal(initial.path, join(folder, 'p4p', 'config.json'));
  await run('disable');
  assert.equal(JSON.parse(await readFile(initial.path, 'utf8')).enabled, false);
  assert.equal(await readFile(oldFile, 'utf8'), before);
  await writeFile(oldFile, JSON.stringify({ ...settings, patterns: ['later-old-change'] }));
  assert.deepEqual((await run('status')).settings.patterns, settings.patterns);
  await writeFile(initial.path, '{');
  await assert.rejects(run('status'));
});

test('new environment names have priority; old configuration and Python variables still work', async t => {
  const { folder, env, run } = await fixture(t);
  const oldFile = join(folder, 'legacy.json'), newFile = join(folder, 'current.json');
  await writeFile(oldFile, JSON.stringify({ ...defaultSettings(), patterns: ['private'] }));
  await writeFile(newFile, JSON.stringify({ ...defaultSettings(), patterns: ['current'] }));
  env.BATYA_CONFIG = oldFile;
  assert.equal(await run('config', 'path'), oldFile);
  env.P4P_CONFIG = newFile;
  assert.equal(await run('config', 'path'), newFile);
  assert.equal(await run('--config', oldFile, 'config', 'path'), oldFile);
  env.BATYA_PYTHON = 'nonexistent-legacy-python'; env.P4P_PYTHON = 'python3';
  assert.equal((await run('preview', '--text', 'current')).restored, 'current');
  delete env.P4P_PYTHON; env.BATYA_PYTHON = 'python3';
  assert.equal((await run('preview', '--text', 'current')).statistics.replacements, 1);
});

test('installation replaces the former plugin entry and preserves its custom settings and unrelated plugins', async t => {
  const { folder, run } = await fixture(t);
  const oldPackage = join(folder, 'old-package'); await mkdir(oldPackage);
  await writeFile(join(oldPackage, 'package.json'), JSON.stringify({ name: 'batya' }));
  const custom = join(folder, 'custom-config.json');
  const target = join(folder, 'opencode.json');
  await writeFile(target, JSON.stringify({ plugins: ['other-plugin', 'batya', 'https://github.com/BeeTrain/batya.git', { package: oldPackage, options: { config: custom } }] }));
  await run('install', '--opencode-config', target);
  await run('install', '--opencode-config', target);
  const installed = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(installed.plugins.length, 2); assert.equal(installed.plugins[0], 'other-plugin');
  assert.equal(installed.plugins[1].package, resolve('.')); assert.equal(installed.plugins[1].options.config, custom);
});

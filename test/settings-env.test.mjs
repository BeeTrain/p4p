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
  const folder = await mkdtemp(join(tmpdir(), 'p4p-settings-env-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const env = { ...process.env, XDG_CONFIG_HOME: folder };
  for (const key of ['P4P_CONFIG', 'P4P_PYTHON']) delete env[key];
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, '--json', ...args], { env })).stdout);
  return { folder, env, run };
}

test('default settings use the XDG configuration directory and reject malformed files', async t => {
  const { folder, run } = await fixture(t);
  const initial = await run('status');
  assert.deepEqual(initial.settings, defaultSettings()); assert.equal(initial.path, join(folder, 'p4p', 'config.json'));
  await run('disable');
  assert.equal(JSON.parse(await readFile(initial.path, 'utf8')).enabled, false);
  assert.equal((await run('status')).settings.enabled, false);
  await writeFile(initial.path, '{');
  await assert.rejects(run('status'));
});

test('environment variables configure settings and Python; explicit configuration takes priority', async t => {
  const { folder, env, run } = await fixture(t);
  const explicitFile = join(folder, 'explicit.json'), configFile = join(folder, 'current.json');
  await writeFile(explicitFile, JSON.stringify({ ...defaultSettings(), patterns: ['private'] }));
  await writeFile(configFile, JSON.stringify({ ...defaultSettings(), patterns: ['current'] }));
  env.P4P_CONFIG = configFile;
  assert.equal(await run('config', 'path'), configFile);
  assert.equal(await run('--config', explicitFile, 'config', 'path'), explicitFile);
  env.P4P_PYTHON = 'nonexistent-python';
  await assert.rejects(run('preview', '--text', 'current'), /P4P_PYTHON/);
  env.P4P_PYTHON = process.platform === 'win32' ? 'python' : 'python3';
  assert.equal((await run('preview', '--text', 'current')).restored, 'current');
  delete env.P4P_PYTHON;
  assert.equal((await run('preview', '--text', 'current')).statistics.replacements, 1);
});

test('installation replaces p4p entries and preserves custom settings and unrelated plugins', async t => {
  const { folder, run } = await fixture(t);
  const localPackage = join(folder, 'local-package'); await mkdir(localPackage);
  await writeFile(join(localPackage, 'package.json'), JSON.stringify({ name: 'p4p' }));
  const custom = join(folder, 'custom-config.json');
  const target = join(folder, 'opencode.json');
  await writeFile(target, JSON.stringify({ plugins: ['other-plugin', 'p4p', 'https://github.com/BeeTrain/p4p.git', { package: localPackage, options: { config: custom } }] }));
  await run('install', '--opencode-config', target);
  await run('install', '--opencode-config', target);
  const installed = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(installed.plugins.length, 2); assert.equal(installed.plugins[0], 'other-plugin');
  assert.equal(installed.plugins[1].package, resolve('.')); assert.equal(installed.plugins[1].options.config, custom);
});

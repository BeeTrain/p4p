import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { OpenCode } from '@opencode/client';
import { BatyaRpc } from '../dist/rpc.js';

test('native OpenCode RPC: shared settings, preview, validation errors, revision conflicts and Desktop GUI bundle', { skip: process.env.BATYA_LIVE_TEST !== '1', timeout: 30000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'batya-rpc-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const project = join(folder, 'project'); await mkdir(project);
  const config = join(folder, 'batya.json'), owner = join(folder, 'opencode.json');
  await writeFile(owner, JSON.stringify({ plugins: [{ package: resolve('.'), options: { config } }], share: 'disabled', autoupdate: false, snapshot: false, mcp: {}, enabled_providers: [] }));
  const env = { ...process.env, OPENCODE_PASSWORD: 'batya-local-rpc-test', OPENCODE_CONFIG: owner, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_SHARE: '1' };
  for (const item of ['DATA', 'CACHE', 'STATE', 'CONFIG']) { const path = join(folder, item.toLowerCase()); await mkdir(path); env[`XDG_${item}_HOME`] = path; }
  const child = spawn(process.env.OPENCODE_BIN || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += String(chunk).replace(/server password[^\n]*/g, 'server password [redacted]'); }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'close'); });
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: 'Basic ' + Buffer.from('opencode:batya-local-rpc-test').toString('base64') } });
  const rpc = client.rpc(BatyaRpc), options = { location: { directory: project }, signal: AbortSignal.timeout(10000) };
  let view, failure;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { view = await rpc.get({}, options); break; }
    catch (error) { failure = error; if (child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(view, String(failure) + logs);
  assert.equal(view.path, config); assert.deepEqual(view.settings.patterns, []);
  const settings = { ...view.settings, patterns: ['(?i)sample-private'], hosts: ['api.example.test'] };
  const saved = await rpc.save({ settings, revision: view.revision }, options);
  const result = await rpc.preview({ settings: saved.settings, text: 'SAMPLE-PRIVATE', host: 'https://api.example.test/v1' }, options);
  assert.equal(result.restored, 'SAMPLE-PRIVATE'); assert.equal(result.hostMatches, true); assert(!('mapping' in result));
  await assert.rejects(rpc.save({ settings, revision: view.revision }, options), error => error.type === 'invalid' && /изменились/.test(error.message));
  await assert.rejects(rpc.preview({ settings: { ...settings, patterns: ['['] }, text: 'hello' }, options), error => error.type === 'invalid' && /Регулярное выражение 1/.test(error.message));
  const gui = await client.plugin.gui({ id: 'batya', location: { directory: project } });
  assert(gui.data.code.includes('batya-root')); assert(gui.data.code.includes('SettingsPage'));
});

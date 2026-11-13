import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { OpenCode } from '@opencode/client';
import { FailureStore, FailureTickets } from '../dist/core/index.js';
import { P4pRpc } from '../dist/rpc.js';

test('native OpenCode RPC: shared settings, preview, validation errors, revision conflicts and Desktop GUI bundle', { skip: process.env.P4P_LIVE_TEST !== '1', timeout: 30000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-rpc-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const project = join(folder, 'project'); await mkdir(project);
  const config = join(folder, 'p4p.json'), owner = join(folder, 'opencode.json');
  await writeFile(owner, JSON.stringify({ plugins: [{ package: resolve('.'), options: { config } }], share: 'disabled', autoupdate: false, snapshot: false, mcp: {}, enabled_providers: [] }));
  const env = { ...process.env, OPENCODE_PASSWORD: 'p4p-local-rpc-test', OPENCODE_CONFIG: owner, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_SHARE: '1' };
  for (const item of ['DATA', 'CACHE', 'STATE', 'CONFIG']) { const path = join(folder, item.toLowerCase()); await mkdir(path); env[`XDG_${item}_HOME`] = path; }
  const child = spawn(process.env.OPENCODE_BIN || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += String(chunk).replace(/server password[^\n]*/g, 'server password [redacted]'); }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'close'); });
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: 'Basic ' + Buffer.from('opencode:p4p-local-rpc-test').toString('base64') } });
  const rpc = client.rpc(P4pRpc), options = { location: { directory: project }, signal: AbortSignal.timeout(10000) };
  let view, failure;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { view = await rpc.get({}, options); break; }
    catch (error) { failure = error; if (child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(view, String(failure) + logs);
  assert.equal(view.path, config); assert.deepEqual(view.settings.patterns, []);
  const settings = { ...view.settings, patterns: ['(?i)sample-private'], hosts: ['api.example.test'] };
  let saved = await rpc.save({ settings, revision: view.revision }, options);
  for (const recordRequests of [false, true]) {
    saved = await rpc.save({ settings: { ...saved.settings, recordRequests }, revision: saved.revision }, options);
    assert.equal(saved.settings.recordRequests, recordRequests);
    assert.equal((await rpc.get({}, options)).settings.recordRequests, recordRequests);
  }
  for (const requestLogFilter of ['failed', 'succeeded', 'all']) {
    saved = await rpc.save({ settings: { ...saved.settings, requestLogFilter }, revision: saved.revision }, options);
    assert.equal((await rpc.get({}, options)).settings.requestLogFilter, requestLogFilter);
  }
  const disabled = await rpc.setEnabled({ enabled: false }, options);
  assert.equal(disabled.settings.enabled, false);
  assert.deepEqual(disabled.settings.patterns, settings.patterns);
  assert.deepEqual(disabled.settings.hosts, settings.hosts);
  const enabled = await rpc.setEnabled({ enabled: true }, options);
  assert.equal(enabled.settings.enabled, true);
  await assert.rejects(rpc.setEnabled({ enabled: 'yes' }, options));
  const result = await rpc.preview({ settings: saved.settings, text: 'SAMPLE-PRIVATE', host: 'https://api.example.test/v1' }, options);
  assert.equal(result.restored, 'SAMPLE-PRIVATE'); assert.equal(result.hostMatches, true); assert(!('mapping' in result));
  await assert.rejects(rpc.save({ settings, revision: view.revision }, options), error => error.type === 'invalid' && /изменились/.test(error.message));
  await assert.rejects(rpc.preview({ settings: { ...settings, patterns: ['['] }, text: 'hello' }, options), error => error.type === 'invalid' && /Регулярное выражение 1/.test(error.message));
  const file = await rpc.exportConfig({}, options);
  assert.equal(file.name, 'p4p-config.json');
  assert.deepEqual(JSON.parse(file.content), (await rpc.get({}, options)).settings);
  const beforeImport = await rpc.get({}, options);
  const imported = await rpc.importConfig({ content: JSON.stringify({ ...settings, enabled: false }) }, options);
  assert.equal(imported.enabled, false);
  assert.equal((await rpc.get({}, options)).revision, beforeImport.revision);
  await assert.rejects(rpc.importConfig({ content: '{' }, options), error => error.type === 'invalid');
  await assert.rejects(rpc.exportConfig({ settings: { ...settings, patterns: ['['] } }, options), error => error.type === 'invalid');
  const failures = new FailureStore(config), tickets = new FailureTickets(failures);
  const pending = tickets.begin({ sessionID: 'rpc-pending', agent: 'build', model: { providerID: 'local', id: 'fixture' } }, 'http', 'https://example.test', [], {}, 2);
  const success = tickets.begin({ sessionID: 'rpc-websocket', agent: 'build', model: { providerID: 'local', id: 'fixture' } }, 'websocket', 'wss://example.test', [], {}, 2);
  await tickets.complete(success, 'succeeded');
  for (let index = 0; index < 2; index++) {
    const listing = await rpc.listFailures({}, options);
    assert.equal(listing.rows.find(row => row.id === pending.row.id).status, 'unknown');
    assert.equal(listing.rows.find(row => row.id === success.row.id).status, 'succeeded');
  }
  await failures.clear();
  const ticket = tickets.begin({ sessionID: 'rpc-fixture', agent: 'build', model: { providerID: 'local', id: 'fixture' } }, 'http', 'https://example.test', [], { messages: [] }, 15);
  await tickets.fail(ticket, { message: 'RPC fixture' }, '', 422);
  const listing = await rpc.listFailures({}, options); assert.equal(listing.rows[0].id, ticket.row.id);
  const report = await rpc.exportFailure({ id: ticket.row.id }, options); assert.equal(report.name, `model-request-${ticket.row.id}.json`); assert.equal(JSON.parse(report.content).http_status, 422);
  await assert.rejects(rpc.exportFailure({ id: '../config.json' }, options));
  await rpc.clearFailures({}, options); assert.equal((await rpc.listFailures({}, options)).rows.length, 0);
  const gui = await client.plugin.gui({ id: 'p4p', location: { directory: project } });
  assert(gui.data.code.includes('p4p-root')); assert(gui.data.code.includes('SettingsPage'));
});

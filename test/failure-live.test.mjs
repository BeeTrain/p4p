import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { SettingsStore, defaultSettings, FailureStore } from '../dist/core/index.js';

for (const socketMode of [false, true]) test(`installed OpenCode captures a failed ${socketMode ? 'WebSocket' : 'HTTP 422'} model request for JSON export`, { skip: process.env.P4P_LIVE_TEST !== '1', timeout: 45000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-failed-live-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const project = join(folder, 'project'); await mkdir(project);
  const received = [], credential = 'local-failed-request-fixture', privateText = 'sample-private-fixture';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Synthetic fixture rejection ' + credential } }));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', client => client.on('message', bytes => {
    received.push(JSON.parse(String(bytes)));
    client.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_request_error', status: 422, message: 'Synthetic fixture rejection ' + credential } }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const client of ws.clients) client.terminate(); ws.close(); server.closeAllConnections(); server.close(); });
  const port = server.address().port, config = join(folder, 'p4p.json'), owner = join(folder, 'opencode.json');
  await new SettingsStore(config).save({ ...defaultSettings(), patterns: [privateText], hosts: [`127.0.0.1:${port}`] });
  const provider = socketMode
    ? { providers: { local: { name: 'Local failure fixture', package: '@opencode/ai/providers/openai', activation: 'enabled', settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: credential, transport: 'websocket' }, models: { fixture: { name: 'Fixture', limit: { context: 100000, output: 1000 } } } } } }
    : { provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: credential }, models: { fixture: { name: 'Fixture', limit: { context: 100000, output: 1000 } } } } }, enabled_providers: ['local'] };
  await writeFile(owner, JSON.stringify({ plugins: [{ package: resolve('.'), options: { config } }], ...provider, model: 'local/fixture', share: 'disabled', snapshot: false, mcp: {}, permission: 'allow' }));
  const env = { ...process.env, OPENCODE_CONFIG: owner, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_SHARE: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1' };
  for (const item of ['DATA', 'CACHE', 'STATE', 'CONFIG']) { const path = join(folder, item.toLowerCase()); await mkdir(path); env[`XDG_${item}_HOME`] = path; }
  const child = spawn(process.env.OPENCODE_BIN || 'opencode', ['run', '--standalone', '--model', 'local/fixture', '--format', 'json', '--title', 'p4p failure export fixture'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 35000); t.after(() => clearTimeout(timer));
  child.stdin.end(privateText); await once(child, 'close');
  assert(received.length >= 1, output); assert(!JSON.stringify(received).includes(privateText));
  const failures = new FailureStore(config), rows = (await failures.listing()).rows;
  assert(rows.length >= 1, output);
  const row = rows.find(row => row.source === (socketMode ? 'websocket' : 'http'));
  assert(row, JSON.stringify(rows) + output);
  const document = await failures.export(row.id), value = JSON.parse(document.content);
  assert.equal(document.name, `model-request-${row.id}.json`); assert.equal(value.http_status, 422);
  assert.match(JSON.stringify(value.request), /sample-private-fixture/);
  assert(!JSON.stringify(value.masked_request).includes(privateText)); assert.match(JSON.stringify(value.masked_request), /__P4P_/);
  assert.match(JSON.stringify(value.error), /Synthetic fixture rejection/); assert(!document.content.includes(credential));
  assert.equal(value.provider, 'local'); assert.equal(value.model, 'fixture'); assert(value.session_id);
});

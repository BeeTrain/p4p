import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { SettingsStore, defaultSettings } from '../dist/core/index.js';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
test('installed OpenCode WebSocket: masked continuation, split tool arguments, local execution, final snapshots and connection reuse', { skip: process.env.BATYA_LIVE_TEST !== '1', timeout: 45000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'batya-ws-live-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const project = join(folder, 'project'); await mkdir(project);
  const report = join(project, 'result.txt'), secret = 'sample_private_value_42';
  const received = [], failures = [];
  let connections = 0, httpRequests = 0, marker;
  const server = createServer((_request, response) => { httpRequests++; response.writeHead(500); response.end('{}'); });
  const websocket = new WebSocketServer({ server });
  websocket.on('connection', (socket, request) => {
    connections++;
    if (request.headers.authorization !== 'Bearer local-ws-test-only') failures.push('Заголовок авторизации изменён.');
    socket.on('message', message => {
      try {
        const payload = JSON.parse(String(message)); received.push(payload);
        if (JSON.stringify(payload.input).includes(secret)) failures.push('Исходное значение попало в запрос WebSocket.');
        if (received.length === 1) marker = JSON.stringify(payload.input).match(/__BATYA_[0-9a-f]{24}_\d+__/g)?.[0];
        if (!marker) failures.push('Не найдено обозначение в первом запросе.');
        let sequence = 0;
        const responseID = `resp-ws-${received.length}`;
        const send = value => socket.send(JSON.stringify({ sequence_number: sequence++, ...value }));
        send({ type: 'response.created', response: { id: responseID, status: 'in_progress', output: [] } });
        let item;
        if (received.length === 1) {
          const names = payload.tools.map(tool => tool.name), name = names.includes('shell') ? 'shell' : 'bash';
          if (!names.includes(name)) failures.push('Инструмент команд не найден.');
          const command = `printf '%s' ${quote(marker || 'missing')} > ${quote(report)}; printf '%s\\n' ${quote('ERROR ' + marker)}`;
          const args = JSON.stringify({ command, description: 'Local WebSocket test', timeout: 10000 });
          item = { id: 'fc-ws-1', type: 'function_call', call_id: 'call-ws-1', name, arguments: args, status: 'completed' };
          send({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
          for (let index = 0; index < args.length; index += 2) send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: args.slice(index, index + 2) });
          send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args });
        } else {
          const text = marker + ' done_';
          item = { id: 'msg-ws-2', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
          send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } });
          send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          for (let index = 0; index < text.length; index++) send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text[index] });
          send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
          send({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
        }
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { id: responseID, status: 'completed', output: [item], usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 } } });
        if (process.env.BATYA_WS_RECONNECT === '1' && received.length === 1) socket.close(1000, 'local reconnect test');
      } catch (error) { failures.push(String(error)); socket.close(1011, 'test error'); }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const client of websocket.clients) client.terminate(); websocket.close(); server.closeAllConnections(); server.close(); });
  const port = server.address().port, config = join(folder, 'batya.json');
  await new SettingsStore(config).save({ ...defaultSettings(), patterns: [secret], hosts: [`127.0.0.1:${port}`] });
  if (process.env.BATYA_WS_FAILURE === '1') await writeFile(config, JSON.stringify({ ...defaultSettings(), patterns: ['['], hosts: [`127.0.0.1:${port}`] }));
  const owner = join(folder, 'opencode.json');
  await writeFile(owner, JSON.stringify({
    plugins: [{ package: resolve('.'), options: { config } }],
    providers: { local: { name: 'Local WebSocket', package: '@opencode/ai/providers/openai', activation: 'enabled', settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local-ws-test-only', transport: 'websocket' }, models: { 'batya-ws': { name: 'Batya WebSocket', limit: { context: 100000, output: 2000 } } } } },
    model: 'local/batya-ws', share: 'disabled', snapshot: false, mcp: {}, permission: 'allow'
  }));
  const env = { ...process.env, OPENCODE_CONFIG: owner, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_SHARE: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1' };
  for (const item of ['DATA', 'CACHE', 'STATE', 'CONFIG']) { const path = join(folder, item.toLowerCase()); await mkdir(path); env[`XDG_${item}_HOME`] = path; }
  const child = spawn(process.env.OPENCODE_BIN || 'opencode', ['run', '--standalone', '--model', 'local/batya-ws', '--format', 'json', '--title', 'Batya WebSocket test'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 35000); t.after(() => clearTimeout(timer));
  child.stdin.end('Use the local shell tool and then answer: ' + secret);
  const [code] = await once(child, 'close');
  if (process.env.BATYA_WS_FAILURE === '1') {
    assert.equal(received.length, 0, stdout + stderr); assert.equal(connections, 0); assert.equal(httpRequests, 0);
    const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert(events.some(event => event.type === 'error'), stdout + stderr); return;
  }
  assert.equal(code, 0, stdout + stderr); assert.deepEqual(failures, [], stdout + stderr);
  assert.equal(received.length, 2, stdout + stderr); assert.equal(httpRequests, 0, 'Проверка должна использовать WebSocket без HTTP fallback.');
  assert.equal(await readFile(report, 'utf8'), secret);
  if (process.env.BATYA_WS_RECONNECT === '1') assert.equal(connections, 2);
  else { assert.equal(connections, 1); assert.equal(received[1].previous_response_id, 'resp-ws-1', JSON.stringify(received[1])); }
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const output = events.filter(event => event.type === 'text').map(event => event.part?.text || '').join('');
  assert.equal(output, secret + ' done_', stdout + stderr);
});

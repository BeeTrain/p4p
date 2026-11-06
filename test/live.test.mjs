import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { SettingsStore, defaultSettings } from '../dist/core/index.js';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
test('installed OpenCode: request masking, streamed tool arguments, local tool execution, masked tool output and restored answer', { skip: process.env.P4P_LIVE_TEST !== '1', timeout: 120000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-live-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const project = join(folder, 'project'); await mkdir(project);
  const report = join(project, 'result.txt');
  const secret = 'sample_private_value_42';
  const received = [], failures = [];
  const server = createServer(async (req, res) => {
    try {
      if (process.env.P4P_LIVE_FAILURE === '1') { received.push({}); res.writeHead(500); res.end('{}'); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString()); received.push(payload);
      const userText = payload.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
      const marker = userText.match(/__P4P_[0-9a-f]{24}_\d+__/g)?.[0];
      if (!marker || userText.includes(secret)) failures.push('Пользовательский текст не замаскирован.');
      const choices = [];
      if (received.length === 1) {
        const names = payload.tools.map(tool => tool.function.name);
        const name = names.includes('shell') ? 'shell' : 'bash';
        if (!names.includes(name)) failures.push('Инструмент команд не найден.');
        const command = `printf '%s' ${quote(marker || 'missing')} > ${quote(report)}; printf '%s\\n' ${quote('ERROR ' + marker)}`;
        const argumentsText = JSON.stringify({ command, description: 'Local plugin smoke test', timeout: 10000 });
        for (let index = 0; index < argumentsText.length; index += 3) {
          const call = { index: 0, function: { arguments: argumentsText.slice(index, index + 3) } };
          if (index === 0) Object.assign(call, { id: 'call-p4p', type: 'function', function: { ...call.function, name } });
          choices.push({ index: 0, delta: { tool_calls: [call] }, finish_reason: null });
        }
        choices.push({ index: 0, delta: {}, finish_reason: 'tool_calls' });
      } else {
        if (JSON.stringify(payload.messages).includes(secret)) failures.push('Вывод инструмента или история не замаскированы.');
        for (let index = 0; index < (marker || '').length; index += 2) choices.push({ index: 0, delta: { content: marker.slice(index, index + 2) }, finish_reason: null });
        choices.push({ index: 0, delta: {}, finish_reason: 'stop' });
      }
      const wire = choices.map(choice => 'data: ' + JSON.stringify({ id: 'chatcmpl-p4p', object: 'chat.completion.chunk', model: 'p4p-test', choices: [choice], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n').join('') + 'data: [DONE]\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let index = 0; index < wire.length; index += 41) res.write(wire.slice(index, index + 41));
      res.end();
    } catch (error) { failures.push(String(error)); res.writeHead(500); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const config = join(folder, 'p4p.json');
  await new SettingsStore(config).save({ ...defaultSettings(), patterns: [secret], hosts: [`127.0.0.1:${port}`] });
  if (process.env.P4P_LIVE_FAILURE === '1') await writeFile(config, JSON.stringify({ ...defaultSettings(), patterns: ['['], hosts: [`127.0.0.1:${port}`] }));
  const opencode = join(folder, 'opencode.json');
  await writeFile(opencode, JSON.stringify({
    plugins: [{ package: resolve('.'), options: { config } }],
    provider: { local: { name: 'Local test', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local-test-only' }, models: { 'p4p-test': { name: 'p4p test', limit: { context: 100000, output: 2000 } } } } },
    enabled_providers: ['local'], model: 'local/p4p-test', share: 'disabled', autoupdate: false, snapshot: false, formatter: false, lsp: false, mcp: {}, permission: 'allow'
  }));
  const env = { ...process.env, OPENCODE_CONFIG: opencode, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_SHARE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1' };
  for (const item of ['DATA', 'CACHE', 'STATE', 'CONFIG']) { const path = join(folder, item.toLowerCase()); await mkdir(path); env[`XDG_${item}_HOME`] = path; }
  const child = spawn(process.env.OPENCODE_BIN || 'opencode', ['run', '--standalone', '--model', 'local/p4p-test', '--format', 'json', '--title', 'p4p local test'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 100000); t.after(() => clearTimeout(timer));
  child.stdin.end('Use the local shell tool and then answer: ' + secret);
  const [code] = await once(child, 'close');
  if (process.env.P4P_LIVE_FAILURE === '1') {
    assert.equal(received.length, 0, 'Ошибка regex не должна пропускать исходный запрос к модели.');
    assert.match(stdout + stderr, /Регулярное|p4p|p4p/);
    return;
  }
  assert.equal(code, 0, stdout + stderr);
  assert.deepEqual(failures, [], stdout + stderr);
  assert.equal(received.length, 2, stdout + stderr);
  assert.equal(await readFile(report, 'utf8'), secret);
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'text').map(event => event.part?.text || '').join(''), secret, stdout + stderr);
});

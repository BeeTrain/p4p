import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings, normalizeSettings, preview, maskRequest, restoreValue, SettingsStore, MaskingTransport, WebSocketMaskingTransport } from '../dist/core/index.js';

const config = (roots = ['/Users/user/project']) => ({ ...defaultSettings(), hosts: ['localhost:8080'], paths: { enabled: true, mode: 'roots', roots } });
const temporary = async t => {
  const folder = await mkdtemp(join(tmpdir(), 'p4p-paths-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return join(folder, 'config.json');
};

test('path roots preserve project structure, distinguish projects and restore exact text', async () => {
  const text = '/Users/user/project/src/main.ts:12 /Users/user/project/test/main.test.ts /other/project/src/main.ts';
  const result = await preview(config(['/Users/user/project', '/other/project']), text);
  const roots = Object.fromEntries(Object.entries(result.mapping).map(([key, value]) => [value, key]));
  assert.equal(result.value, `${roots['/Users/user/project']}/src/main.ts:12 ${roots['/Users/user/project']}/test/main.test.ts ${roots['/other/project']}/src/main.ts`);
  assert.notEqual(roots['/Users/user/project'], roots['/other/project']);
  assert.equal(result.statistics.path_matches, 3);
  assert.equal(result.statistics.regex_matches, 0);
  assert.equal(result.restored, text);
  assert.equal(await restoreValue(result.value, result.mapping), text);
  assert.deepEqual((await preview(defaultSettings(), text)).value, text);
  assert.equal((await preview({ ...config(), enabled: false }, text)).value, text);
});

test('literal roots respect boundaries, handle overlaps and keep suffixes and filenames', async () => {
  const settings = config(['/work/app', '/work/app/nested', '/work/a.b [1]']);
  const text = '/work/app /work/app/src/a.ts /work/application/a.ts /prefix/work/app/a.ts /work/app-old/a.ts /work/app/nested/a.ts `/work/a.b [1]/a.ts`';
  const result = await preview(settings, text);
  assert.equal(result.statistics.path_matches, 4);
  assert.equal(result.statistics.replacements, 4);
  assert(result.value.includes('/work/application/a.ts'));
  assert(result.value.includes('/prefix/work/app/a.ts'));
  assert(result.value.includes('/work/app-old/a.ts'));
  assert(!result.value.includes('/work/app/nested/'));
  assert(result.value.endsWith('/a.ts`'));
  assert.equal(result.restored, text);
});

test('Windows, UNC, Unicode, spaces and JSON-encoded tool arguments roundtrip', async () => {
  const roots = ['C:\\Users\\user\\My Project', '\\\\server\\share\\project', '/home/пользователь/проект', '~/project'];
  const settings = config(roots);
  const argumentsValue = { file: roots[0] + '\\src\\main.ts' };
  const input = { messages: [{ role: 'user', content: roots.map(root => root + '/src/main.ts').join('\n') }, { role: 'assistant', tool_calls: [{ id: 'kept', type: 'function', function: { name: 'read', arguments: JSON.stringify(argumentsValue) } }] }] };
  const result = await maskRequest(settings, input);
  assert.equal(result.statistics.path_matches, 5);
  for (const root of roots) assert(!result.value.messages[0].content.includes(root));
  assert(!result.value.messages[1].tool_calls[0].function.arguments.includes('Users'));
  assert.deepEqual(await restoreValue(result.value, result.mapping), input);
  const again = await maskRequest(settings, input, result.mapping);
  assert.deepEqual(again.value, result.value);
  assert.deepEqual(again.mapping, result.mapping);
});

test('path switch is independent of dictionary rules and respects diagnostic exemptions', async () => {
  const settings = { ...config(), patterns: ['secret'] };
  const text = '/Users/user/project/src/a.ts secret\n```log\nERROR /Users/user/project/src/a.ts secret\n```';
  settings.diagnostics.logs = false;
  const result = await preview(settings, text);
  assert.equal(result.statistics.path_matches, 1);
  assert.equal(result.statistics.regex_matches, 1);
  assert(result.value.includes('ERROR /Users/user/project/src/a.ts secret'));
  assert.equal(result.restored, text);
  const disabled = await preview({ ...settings, paths: { ...settings.paths, enabled: false } }, text);
  assert.equal(disabled.statistics.path_matches, 0);
  assert(disabled.value.startsWith('/Users/user/project/src/a.ts '));
});

test('component mode preserves hierarchy, extensions and references to new files', async () => {
  const settings = config();
  settings.paths.mode = 'components';
  const input = '/Users/user/project/src/main.ts /Users/user/project/test/main.ts /Users/user/project/.env /Users/user/project/src.v1/';
  const result = await preview(settings, input);
  const names = Object.fromEntries(Object.entries(result.mapping).map(([key, value]) => [value, key]));
  assert.equal(result.value, `/${names.Users}/${names.user}/${names.project}/${names.src}/${names.main}.ts /${names.Users}/${names.user}/${names.project}/${names.test}/${names.main}.ts /${names.Users}/${names.user}/${names.project}/${names['.env']} /${names.Users}/${names.user}/${names.project}/${names['src.v1']}/`);
  assert.equal(result.statistics.path_matches, 4);
  assert.equal(result.restored, input);
  assert.equal(await restoreValue(`/${names.Users}/${names.user}/${names.project}/${names.src}/new.ts`, result.mapping), '/Users/user/project/src/new.ts');
  const again = await maskRequest(settings, { input }, result.mapping);
  assert.equal(again.value.input, result.value);
  assert.deepEqual(again.mapping, result.mapping);
});

test('component mode restores Windows, UNC and quoted paths including spaces and encoded arguments', async () => {
  const roots = ['C:\\Users\\user\\My Project', '\\\\server\\share\\project', '/home/user/my.project'];
  const settings = config(roots);
  settings.paths.mode = 'components';
  const paths = roots.map(root => root + '/src/my file.test.ts');
  const input = { input: paths.map(path => `"${path}"`).join('\n'), tools: [{ function: { arguments: JSON.stringify({ file: paths[0] }) } }] };
  const result = await maskRequest(settings, input);
  assert.equal(result.statistics.path_matches, 4);
  assert(!JSON.stringify(result.value).includes('my file'));
  assert(!JSON.stringify(result.value).includes('my.project'));
  assert.equal((result.value.input.match(/\.ts/g) || []).length, 3);
  assert.deepEqual(await restoreValue(result.value, result.mapping), input);
  const rootOnly = await preview(settings, roots[2]);
  assert(!rootOnly.value.includes('.project'));
  assert.equal(rootOnly.restored, roots[2]);
});

for (const mode of ['roots', 'components']) test(`${mode} masks file URI paths and roots before sentence punctuation`, async () => {
  const settings = config(['/work/app']); settings.paths.mode = mode;
  const input = 'file:///work/app/src/main.ts /work/app. /work/app.ts';
  const result = await preview(settings, input);
  assert.equal(result.statistics.path_matches, 2);
  assert(!result.value.includes('file:///work/app/'));
  assert(!result.value.includes(' /work/app. '));
  assert(result.value.endsWith(' /work/app.ts'));
  assert.equal(result.restored, input);
});

test('legacy settings default to disabled paths and validate and normalize path configuration', async () => {
  const { paths, ...legacy } = defaultSettings();
  assert.deepEqual(normalizeSettings(legacy).paths, { enabled: false, mode: 'roots', roots: [] });
  assert.deepEqual(normalizeSettings(config(['/work/app/', ' /work/app ', 'C:\\work\\app\\'])).paths.roots, ['/work/app', 'C:\\work\\app']);
  for (const paths of [null, [], true, { enabled: 'yes' }, { mode: 'invalid' }, { roots: 'bad' }, { roots: ['/'] }, { roots: ['C:\\'] }, { roots: ['relative/path'] }, { roots: ['/work\napp'] }, { roots: Array(201).fill('/work/app') }, { other: true }]) {
    assert.throws(() => normalizeSettings({ ...legacy, paths }));
    await assert.rejects(preview({ ...legacy, paths }, 'text'));
  }
});

for (const mode of ['roots', 'components']) test(`HTTP ${mode} masks paths without dictionary rules, restores split SSE tool arguments and reloads settings`, async t => {
  const store = new SettingsStore(await temporary(t));
  const settings = config(); settings.paths.mode = mode;
  await store.save(settings);
  const transport = new MaskingTransport(store);
  t.after(() => transport.dispose());
  const request = () => new Request('http://localhost:8080/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: '/Users/user/project/src/main.ts' }) });
  const masked = await transport.request(request());
  const text = (await masked.request.clone().json()).input;
  assert(!text.includes('/Users/user/project'));
  let wire = '';
  for (const part of JSON.stringify({ file: text })) wire += 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } }] }) + '\n\n';
  wire += 'data: [DONE]\n\n';
  const restored = await transport.response(masked.request, new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
  const frames = (await restored.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(JSON.parse(frames.map(frame => frame.choices[0].delta.tool_calls[0].function.arguments).join('')), { file: '/Users/user/project/src/main.ts' });
  await store.update(value => ({ ...value, paths: { ...value.paths, enabled: false } }));
  const original = request();
  assert.equal((await transport.request(original)).request, original);
});

for (const mode of ['roots', 'components']) test(`WebSocket ${mode} masks paths without dictionary rules and restores tool arguments`, async t => {
  const store = new SettingsStore(await temporary(t));
  const settings = config(); settings.paths.mode = mode;
  await store.save(settings);
  const transport = new WebSocketMaskingTransport(store);
  t.after(() => transport.dispose());
  const identity = { sessionID: 'paths', agent: 'build', model: { providerID: 'test', id: 'model' }, kind: 'primary' };
  await transport.handshake({ ...identity, url: 'http://localhost:8080/v1/responses', headers: {} });
  const outgoing = { ...identity, frame: JSON.stringify({ type: 'response.create', input: '/Users/user/project/src/main.ts' }) };
  assert.equal((await transport.send(outgoing)).path_matches, 1);
  const path = JSON.parse(outgoing.frame).input;
  assert(!path.includes('/Users/user/project'));
  const incoming = { ...identity, frame: JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'call', arguments: JSON.stringify({ file: path }) }) };
  transport.receive(incoming);
  assert.deepEqual(JSON.parse(JSON.parse(incoming.frame).arguments), { file: '/Users/user/project/src/main.ts' });
});

test('CLI adds literal roots, toggles masking, previews and removes normalized roots', async t => {
  const path = await temporary(t);
  const exec = promisify(execFile);
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [resolve('dist/cli.js'), '--config', path, '--json', ...args])).stdout);
  assert.deepEqual(await cli('paths', 'show'), { enabled: false, mode: 'roots', roots: [] });
  await cli('paths', 'add', '/work/a.b/');
  await cli('paths', 'enable');
  const masked = await cli('preview', '--text', '/work/a.b/src/main.ts');
  assert(!masked.value.includes('/work/a.b'));
  assert.equal(masked.restored, '/work/a.b/src/main.ts');
  await cli('paths', 'mode', 'components');
  const components = await cli('preview', '--text', '/work/a.b/src/main.ts');
  assert(!components.value.includes('main'));
  assert(components.value.endsWith('.ts'));
  assert.equal(components.restored, '/work/a.b/src/main.ts');
  await cli('paths', 'disable');
  assert.equal((await cli('preview', '--text', '/work/a.b/src/main.ts')).value, '/work/a.b/src/main.ts');
  await cli('paths', 'remove', '/work/a.b/');
  assert.deepEqual(await cli('paths'), { enabled: false, mode: 'components', roots: [] });
});

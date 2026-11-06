import { createServer } from 'vite';
import solid from 'vite-plugin-solid';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SettingsStore, normalizeSettings, preview, matchesHost } from '../dist/core/index.js';
const folder = await mkdtemp(join(tmpdir(), 'batya-ui-'));
const store = new SettingsStore(join(folder, 'config.json'));
const server = await createServer({
  configFile: false,
  resolve: { alias: [{ find: '@opencode/plugin/gui', replacement: resolve('test/preview/gui-host.ts') }] },
  plugins: [solid(), { name: 'batya-test-api', configureServer(server) {
    server.middlewares.use('/__batya', async (request, response) => {
      response.setHeader('content-type', 'application/json');
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        let result;
        if (request.url === '/get') result = await store.read();
        else if (request.url === '/setEnabled') {
          if (typeof input.enabled !== 'boolean') throw new Error('Неверное состояние маскирования');
          result = await store.update(settings => ({ ...settings, enabled: input.enabled }));
        }
        else if (request.url === '/save') result = await store.save(input.settings, input.revision);
        else if (request.url === '/preview') {
          const settings = normalizeSettings(input.settings);
          const { mapping, ...value } = await preview(settings, input.text);
          result = { ...value, hostMatches: input.host ? matchesHost(input.host.includes('://') ? input.host : `https://${input.host}`, settings.hosts) : null };
        } else throw new Error('Неизвестный метод');
        response.end(JSON.stringify(result));
      } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error.message })); }
    });
  } }],
  server: { host: '127.0.0.1', port: 42617, strictPort: true },
});
await server.listen();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); await rm(folder, { recursive: true, force: true }); process.exit(); });

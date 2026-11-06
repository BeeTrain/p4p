import { Plugin } from '@opencode/plugin';
import { BatyaRpc } from './rpc.js';
import { SettingsStore, normalizeSettings, preview, matchesHost, MaskingTransport } from './core/index.js';

export default Plugin.define({
  id: 'batya',
  async setup(ctx) {
    const config = typeof ctx.options.config === 'string' ? ctx.options.config : undefined;
    const store = new SettingsStore(config);
    const transport = new MaskingTransport(store);
    const registrations: Array<{ dispose: () => Promise<void> | void }> = [];
    try {
      registrations.push(await ctx.rpc.register(BatyaRpc, {
        get: async (_input, context) => {
          try { return await store.read(); }
          catch (error) { const message = error instanceof Error ? error.message : 'Не удалось прочитать настройки.'; return context.error('invalid', message, { message }); }
        },
        save: async (input, context) => {
          try {
            const value = input as { settings: unknown; revision: string };
            return await store.save(value.settings, value.revision);
          } catch (error) { const message = error instanceof Error ? error.message : 'Не удалось сохранить настройки.'; return context.error('invalid', message, { message }); }
        },
        preview: async (input, context) => {
          try {
            const value = input as { settings: unknown; text: string; host?: string };
            const settings = normalizeSettings(value.settings);
            const result = await preview(settings, value.text);
            const { mapping, ...publicResult } = result;
            return { ...publicResult, hostMatches: value.host ? matchesHost(value.host.includes('://') ? value.host : `https://${value.host}`, settings.hosts) : null };
          } catch (error) { const message = error instanceof Error ? error.message : 'Не удалось выполнить предпросмотр.'; return context.error('invalid', message, { message }); }
        }
      }));
      registrations.push(await ctx.session.hook('http.request', async event => { event.request = (await transport.request(event.request)).request; }));
      registrations.push(await ctx.session.hook('http.response', async event => { event.response = await transport.response(event.request, event.response); }));
      registrations.push(await ctx.session.hook('experimental.ws.handshake', async event => { await transport.checkWebSocket(event.url); }));
    } catch (error) {
      for (const registration of registrations.reverse()) await registration.dispose();
      throw error;
    }
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  }
});

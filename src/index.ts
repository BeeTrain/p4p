import { Plugin } from '@opencode/plugin';
import { P4pRpc } from './rpc.js';
import { SettingsStore, normalizeSettings, preview, matchesHost, MaskingTransport, WebSocketMaskingTransport, parseConfig, serializeConfig, FailureStore, FailureCapture } from './core/index.js';

export default Plugin.define({
  id: 'p4p',
  async setup(ctx) {
    const config = typeof ctx.options.config === 'string' ? ctx.options.config : undefined;
    const store = new SettingsStore(config);
    const transport = new MaskingTransport(store);
    const webSocket = new WebSocketMaskingTransport(store);
    const failures = new FailureStore(store.path);
    const capture = new FailureCapture(store, failures);
    const lifecycleAbort = new AbortController();
    const registrations: Array<{ dispose: () => Promise<void> | void }> = [];
    try {
      registrations.push(await ctx.rpc.register(P4pRpc, {
        get: async (_input, context) => {
          try { return await store.read(); }
          catch (error) { const message = error instanceof Error ? error.message : 'Не удалось прочитать настройки.'; return context.error('invalid', message, { message }); }
        },
        importConfig: async (input, context) => {
          try { return await parseConfig((input as { content: string }).content); }
          catch (error) { const message = error instanceof Error ? error.message : 'Не удалось импортировать конфигурацию.'; return context.error('invalid', message, { message }); }
        },
        exportConfig: async (input, context) => {
          try { const value = input as { settings?: unknown }; return await serializeConfig(value.settings ?? (await store.read()).settings); }
          catch (error) { const message = error instanceof Error ? error.message : 'Не удалось экспортировать конфигурацию.'; return context.error('invalid', message, { message }); }
        },
        listFailures: async (_input, context) => {
          try { return await failures.listing(); }
          catch (error) { const message = error instanceof Error ? error.message : 'Журнал недоступен.'; return context.error('invalid', message, { message }); }
        },
        exportFailure: async (input, context) => {
          try { return await failures.export((input as { id: string }).id); }
          catch (error) { const message = error instanceof Error ? error.message : 'Запрос не найден.'; return context.error('invalid', message, { message }); }
        },
        clearFailures: async (_input, context) => {
          try { await failures.clear(); return {}; }
          catch (error) { const message = error instanceof Error ? error.message : 'Не удалось очистить журнал.'; return context.error('invalid', message, { message }); }
        },
        setEnabled: async (input, context) => {
          try {
            const value = input as { enabled: boolean };
            return await store.update(settings => ({ ...settings, enabled: value.enabled }));
          } catch (error) { const message = error instanceof Error ? error.message : 'Не удалось переключить маскирование.'; return context.error('invalid', message, { message }); }
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
      registrations.push(await ctx.session.hook('http.request', async event => {
        const ticket = await capture.httpStart(event);
        try { const result = await transport.request(event.request, event); event.request = result.request; await capture.httpSent(ticket, event.request, result.statistics); }
        catch (error) { await capture.httpFailure(event.request, error); throw error; }
      }));
      registrations.push(await ctx.session.hook('http.response', async event => {
        await capture.httpResponse(event.request, event.response);
        try { event.response = capture.observe(event.request, await transport.response(event.request, event.response)); }
        catch (error) { await capture.httpFailure(event.request, error); throw error; }
      }));
      registrations.push(await ctx.session.hook('experimental.ws.handshake', async event => {
        await capture.wsHandshake(event);
        try { await webSocket.handshake(event); } catch (error) { await capture.wsFailure(event, error); throw error; }
      }));
      registrations.push(await ctx.session.hook('experimental.ws.send', async event => {
        const ticket = await capture.wsStart(event);
        try { const statistics = await webSocket.send(event); capture.wsSent(ticket, event.frame, statistics); }
        catch (error) { await capture.wsFailure(event, error); throw error; }
      }));
      registrations.push(await ctx.session.hook('experimental.ws.receive', async event => {
        await capture.wsReceive(event);
        try { webSocket.receive(event); } catch (error) { await capture.wsFailure(event, error); throw error; }
      }));
      registrations.push(await ctx.session.hook('retry', event => capture.retry(event)));
      void (async () => {
        for await (const event of ctx.event.subscribe({ types: ['session.deleted', 'session.execution.interrupted', 'session.execution.failed', 'session.idle'], signal: lifecycleAbort.signal })) {
          if (event.type === 'session.execution.failed') await capture.failed(event.data.sessionID, event.data.error);
          else capture.finish(event.data.sessionID, event.type === 'session.deleted');
          if (event.type === 'session.deleted') { transport.remove(event.data.sessionID); webSocket.remove(event.data.sessionID); }
          else webSocket.interrupt(event.data.sessionID);
        }
      })().catch(() => { if (!lifecycleAbort.signal.aborted) { transport.dispose(); webSocket.dispose(); } });
    } catch (error) {
      lifecycleAbort.abort();
      transport.dispose();
      webSocket.dispose();
      await capture.dispose();
      for (const registration of registrations.reverse()) await registration.dispose();
      throw error;
    }
    return async () => { lifecycleAbort.abort(); transport.dispose(); webSocket.dispose(); await capture.dispose(); for (const registration of registrations.reverse()) await registration.dispose(); };
  }
});

import { Plugin, SettingsPage, Panel, Command, Style } from '@opencode/plugin/gui';
import { BatyaRpc } from './rpc.js';
import { Editor, type BatyaApi } from './ui.js';
import type { SettingsView } from './core/types.js';
import css from './ui.css?inline';

export default Plugin.define({
  setup(ctx) {
    const api: BatyaApi = {
      get: async () => await ctx.client.rpc(BatyaRpc).get({}) as SettingsView,
      save: async (settings, revision) => await ctx.client.rpc(BatyaRpc).save({ settings, revision }) as SettingsView,
      preview: async (settings, text, host) => await ctx.client.rpc(BatyaRpc).preview({ settings, text, host }) as Awaited<ReturnType<BatyaApi['preview']>>
    };
    const tab = { id: 'main', title: 'Batya', closable: true };
    ctx.add(Style, css);
    ctx.add(SettingsPage, { id: 'batya', title: 'Batya', render: () => <Editor api={api} /> });
    ctx.add(Panel, { id: 'main', region: 'side', list: input => input.open.includes('main') ? [tab] : [], render: () => <Editor api={api} /> });
    ctx.add(Command, { id: 'open', title: 'Batya: открыть настройки', description: 'Словарь, хосты и предпросмотр маскирования', slash: { name: 'batya' }, run: () => { const session = ctx.sessions.current(); if (session) ctx.layout.toggle(`${ctx.id}:main`, session); else ctx.layout.settings('batya'); } });
  }
});

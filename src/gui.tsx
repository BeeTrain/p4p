import { createEffect, onCleanup } from 'solid-js';
import { Plugin, SettingsPage, Panel, Command, Style, ComposerPill } from '@opencode/plugin/gui';
import { BatyaRpc } from './rpc.js';
import { Editor, type BatyaApi } from './ui.js';
import { createComposerControls, type ComposerApi } from './composer.js';
import type { SettingsView } from './core/types.js';
import css from './ui.css?inline';

export default Plugin.define({
  setup(ctx) {
    const api: BatyaApi & ComposerApi = {
      get: async () => await ctx.client.rpc(BatyaRpc).get({}) as SettingsView,
      setEnabled: async enabled => await ctx.client.rpc(BatyaRpc).setEnabled({ enabled }) as SettingsView,
      save: async (settings, revision) => await ctx.client.rpc(BatyaRpc).save({ settings, revision }) as SettingsView,
      preview: async (settings, text, host) => await ctx.client.rpc(BatyaRpc).preview({ settings, text, host }) as Awaited<ReturnType<BatyaApi['preview']>>
    };
    const controls = createComposerControls(api, description => ctx.toast.show({ title: 'Batya', description, variant: 'error' }));
    const tab = { id: 'main', title: 'Batya', closable: true };
    const editor = () => <Editor api={api} onSaved={controls.accept} />;
    const openSettings = () => ctx.dialogs.open(() => <ctx.ui.Dialog title="Настройки Batya" size="x-large">{editor()}</ctx.ui.Dialog>);
    const localSession = () => ctx.sessions.current()?.server.builtin;
    createEffect(() => { if (localSession()) void controls.refresh(); });
    const interval = setInterval(() => { if (localSession()) void controls.refresh(); }, 2000);
    const focus = () => { if (localSession()) void controls.refresh(); };
    window.addEventListener('focus', focus);
    onCleanup(() => { clearInterval(interval); window.removeEventListener('focus', focus); controls.dispose(); });
    ctx.add(Style, css);
    ctx.add(SettingsPage, { id: 'batya', title: 'Batya', render: editor });
    ctx.add(Panel, { id: 'main', region: 'side', list: input => input.open.includes('main') ? [tab] : [], render: editor });
    ctx.add(ComposerPill, { id: 'toggle', order: 0, show: input => input.session.server.builtin ? controls.view() : undefined });
    ctx.add(ComposerPill, { id: 'settings', order: 1, show: input => input.session.server.builtin ? { label: '', icon: 'settings-gear', title: 'Настройки Batya', run: openSettings } : undefined });
    ctx.add(Command, { id: 'open', title: 'Batya: открыть настройки', description: 'Словарь, хосты и предпросмотр маскирования', slash: { name: 'batya' }, run: () => { const session = ctx.sessions.current(); if (session) ctx.layout.toggle(`${ctx.id}:main`, session); else ctx.layout.settings('batya'); } });
  }
});

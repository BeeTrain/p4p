import { createEffect, onCleanup } from 'solid-js';
import { Plugin, SettingsPage, Panel, Command, Style, ComposerPill } from '@opencode/plugin/gui';
import { P4pRpc } from './rpc.js';
import { Editor, type P4pApi } from './ui.js';
import { createComposerControls, type ComposerApi } from './composer.js';
import type { ConfigDocument } from './core/config-transfer.js';
import type { Settings, SettingsView } from './core/types.js';
import css from './ui.css?inline';

export default Plugin.define({
  setup(ctx) {
    const api: P4pApi & ComposerApi = {
      importConfig: async content => await ctx.client.rpc(P4pRpc).importConfig({ content }) as Settings,
      exportConfig: async settings => await ctx.client.rpc(P4pRpc).exportConfig({ settings }) as ConfigDocument,
      get: async () => await ctx.client.rpc(P4pRpc).get({}) as SettingsView,
      setEnabled: async enabled => await ctx.client.rpc(P4pRpc).setEnabled({ enabled }) as SettingsView,
      save: async (settings, revision) => await ctx.client.rpc(P4pRpc).save({ settings, revision }) as SettingsView,
      preview: async (settings, text, host) => await ctx.client.rpc(P4pRpc).preview({ settings, text, host }) as Awaited<ReturnType<P4pApi['preview']>>
    };
    const controls = createComposerControls(api, description => ctx.toast.show({ title: 'p4p', description, variant: 'error' }));
    const tab = { id: 'main', title: 'p4p', closable: true };
    const editor = () => <Editor api={api} onSaved={controls.accept} saveFile={file => ctx.system.save(file)} confirmReplace={() => ctx.dialogs.confirm({ title: 'Заменить несохранённые изменения?', description: 'Поля формы будут заменены импортируемой конфигурацией.', confirm: 'Заменить', cancel: 'Отмена' })} />;
    const openSettings = () => ctx.dialogs.open(() => <ctx.ui.Dialog title="Настройки p4p" size="x-large">{editor()}</ctx.ui.Dialog>);
    const localSession = () => ctx.sessions.current()?.server.builtin;
    createEffect(() => { if (localSession()) void controls.refresh(); });
    const interval = setInterval(() => { if (localSession()) void controls.refresh(); }, 2000);
    const focus = () => { if (localSession()) void controls.refresh(); };
    window.addEventListener('focus', focus);
    onCleanup(() => { clearInterval(interval); window.removeEventListener('focus', focus); controls.dispose(); });
    ctx.add(Style, css);
    ctx.add(SettingsPage, { id: 'p4p', title: 'p4p', render: editor });
    ctx.add(Panel, { id: 'main', region: 'side', list: input => input.open.includes('main') ? [tab] : [], render: editor });
    ctx.add(ComposerPill, { id: 'toggle', order: 0, show: input => input.session.server.builtin ? controls.view() : undefined });
    ctx.add(ComposerPill, { id: 'settings', order: 1, show: input => input.session.server.builtin ? { label: '', icon: 'settings-gear', title: 'Настройки p4p', run: openSettings } : undefined });
    ctx.add(Command, { id: 'open', title: 'p4p: открыть настройки', description: 'Словарь, хосты и предпросмотр маскирования', slash: { name: 'p4p' }, run: () => { const session = ctx.sessions.current(); if (session) ctx.layout.toggle(`${ctx.id}:main`, session); else ctx.layout.settings('p4p'); } });
  }
});

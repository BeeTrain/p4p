import { createRoot, createSignal, For, Show } from 'solid-js';
import { render } from 'solid-js/web';
import gui from '../../src/gui';
import { ComposerPill, Style } from './gui-host';

async function call(method: string, body = {}) {
  const response = await fetch('/__p4p/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw { message: value.error };
  return value;
}
createRoot(() => {
  const contributions = new Map<symbol, any[]>();
  const [dialog, setDialog] = createSignal<((handle: any) => any)>();
  const [toast, setToast] = createSignal('');
  const [session, setSession] = createSignal({ key: 'test-session', server: { builtin: true } });
  const [sent, setSent] = createSignal(0);
  const close = () => setDialog(undefined);
  const ctx: any = {
    id: 'p4p',
    client: { rpc: () => ({ get: () => call('get'), listFailures: () => call('listFailures'), exportFailure: (value: unknown) => call('exportFailure', value), clearFailures: () => call('clearFailures'), importConfig: (value: unknown) => call('importConfig', value), exportConfig: (value: unknown) => call('exportConfig', value), setEnabled: (value: unknown) => call('setEnabled', value), save: (value: unknown) => call('save', value), preview: (value: unknown) => call('preview', value) }) },
    sessions: { current: session },
    add(registry: symbol, contribution: any) {
      if (registry === Style) { const style = document.createElement('style'); style.textContent = contribution; document.head.append(style); }
      const list = contributions.get(registry) || []; list.push(contribution); contributions.set(registry, list);
    },
    system: { save: async (file: { name: string; content: string }) => { const url = URL.createObjectURL(new Blob([file.content], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true; } },
    dialogs: { confirm: async () => window.confirm('Заменить несохранённые изменения импортируемой конфигурацией?'), open: (content: any) => { setDialog(() => content); return { close }; } },
    toast: { show: (value: any) => { setToast(value.description); return { dismiss: () => setToast('') }; } },
    layout: { toggle: () => {}, settings: () => {} },
    ui: { Dialog: (props: any) => <div class="test-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}><section role="dialog" aria-label={props.title} class="test-dialog"><header><strong>{props.title}</strong><button aria-label="Закрыть" onClick={close}>×</button></header><div class="test-dialog-content">{props.children}</div></section></div> }
  };
  gui.setup!(ctx);
  const pills = contributions.get(ComposerPill) || [];
  const icon = (name: string) => name === 'settings-gear'
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-.6 3-2.7 1.6L3 7l-2 4 2.3 2-.1 3L5 19l3-.6 2 2.4h4l2-2.4 3 .6 2-3-.4-3 2.4-2-2-4-2.7.6L16 6l-1-3z"/><circle cx="12" cy="12" r="3.2"/></svg>
    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/>{name === 'shield' ? <path d="m8 12 3 3 5-6"/> : <path d="m8 8 8 8"/>}</svg>;
  render(() => <>
    <div class="test-composer"><div class="test-pills"><For each={pills}>{pill => <Show when={pill.show({ get session() { return session(); }, screen: {} })}>{view => <button class="test-pill" data-tone={view().tone} aria-label={view().title || view().label} title={view().title} disabled={!view().run} onClick={() => view().run?.()}>{icon(view().icon)}{view().label && <span>{view().label}</span>}</button>}</Show>}</For></div><div class="test-input"><textarea aria-label="Сообщение" placeholder="Спросите что угодно, / — команды, @ — контекст…"/><footer><span>＋　Local / Test model</span><button class="test-send" aria-label="Отправить сообщение" onClick={() => setSent(value => value + 1)}>↑</button></footer></div></div>
    <div class="test-utils"><p>Отправлено сообщений: {sent()}</p><button onClick={() => setSession(value => ({ ...value, server: { builtin: !value.server.builtin } }))}>Переключить сервер</button></div>
    <Show when={dialog()}>{content => content()({ close })}</Show>
    <Show when={toast()}><div role="alert" class="test-toast">{toast()}</div></Show>
  </>, document.getElementById('app')!);
});

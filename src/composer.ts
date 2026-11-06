import { createSignal } from 'solid-js';
import type { ComposerPillView } from '@opencode/plugin/gui';
import type { SettingsView } from './core/types.js';

export interface ComposerApi {
  get(): Promise<SettingsView>;
  setEnabled(enabled: boolean): Promise<SettingsView>;
}
export function createComposerControls(api: ComposerApi, notify: (message: string) => void) {
  const [state, setState] = createSignal<{ view?: SettingsView; busy: boolean; error: string }>({ busy: false, error: '' });
  let live = true, loading = false, generation = 0;
  const messageOf = (error: unknown) => error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Не удалось обновить настройки Batya.';
  const accept = (view: SettingsView) => { if (live) { generation++; setState({ view, busy: false, error: '' }); } };
  const refresh = async () => {
    if (!live || loading || state().busy) return;
    loading = true;
    const current = generation;
    try { const view = await api.get(); if (live && current === generation) setState({ view, busy: false, error: '' }); }
    catch (error) { if (live && current === generation) setState(previous => ({ ...previous, error: messageOf(error) })); }
    finally { loading = false; }
  };
  const toggle = async () => {
    const previous = state();
    if (!live || !previous.view || previous.busy || previous.error) return;
    generation++;
    setState({ ...previous, busy: true, error: '' });
    try { accept(await api.setEnabled(!previous.view.settings.enabled)); }
    catch (error) {
      if (live) { const message = messageOf(error); setState(value => ({ ...value, busy: false, error: message })); notify(message); }
    }
  };
  const view = (): ComposerPillView => {
    const current = state();
    if (current.error) return { label: 'Batya: ошибка', icon: 'circle-exclamation', tone: 'danger', title: current.error + ' Нажмите, чтобы повторить загрузку.', run: () => void refresh() };
    if (current.busy) return { label: 'Batya: сохраняю…', icon: 'refresh', title: 'Сохраняю состояние маскирования Batya' };
    if (!current.view) return { label: 'Batya: загрузка…', icon: 'refresh', title: 'Загрузка состояния маскирования Batya' };
    const settings = current.view.settings;
    const hint = !settings.hosts.length ? ' Хосты моделей не выбраны.' : !settings.patterns.length ? ' Словарь пуст.' : '';
    return { label: `Batya: ${settings.enabled ? 'вкл.' : 'выкл.'}`, icon: settings.enabled ? 'shield' : 'circle-ban-sign', tone: settings.enabled ? 'success' : undefined, title: `${settings.enabled ? 'Отключить' : 'Включить'} маскирование Batya.${hint}`, run: () => void toggle() };
  };
  return { view, refresh, accept, dispose: () => { live = false; generation++; } };
}

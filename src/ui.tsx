import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import type { Diagnostics, Settings, SettingsView, TransformResult } from './core/types.js';
import defaults from './core/defaults.json';
import { FailureHistory, type FailureApi } from './failure-ui.js';
import type { ConfigDocument } from './core/config-transfer.js';

export interface P4pApi extends FailureApi {
  get(): Promise<SettingsView>;
  importConfig(content: string): Promise<Settings>;
  exportConfig(settings: Settings): Promise<ConfigDocument>;
  save(settings: Settings, revision: string): Promise<SettingsView>;
  preview(settings: Settings, text: string, host: string): Promise<Omit<TransformResult, 'mapping'> & { hostMatches: boolean | null }>;
}
export function Editor(props: { api: P4pApi; onSaved?: (view: SettingsView) => void; saveFile?: (file: ConfigDocument) => Promise<boolean>; confirmReplace?: () => Promise<boolean>; confirmClear?: () => Promise<boolean> }) {
  const uid = createUniqueId();
  const [base, setBase] = createSignal<SettingsView>();
  const [settings, setSettings] = createSignal(structuredClone(defaults) as Settings);
  const [rules, setRules] = createSignal('');
  const [hosts, setHosts] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [text, setText] = createSignal('');
  const [host, setHost] = createSignal('');
  const [result, setResult] = createSignal<Awaited<ReturnType<P4pApi['preview']>>>();
  let fileInput: HTMLInputElement | undefined;
  let live = true;
  onCleanup(() => { live = false; });
  const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const draft = (): Settings => ({ ...settings(), patterns: lines(rules()), hosts: lines(hosts()) });
  const dirty = () => !!base() && JSON.stringify(draft()) !== JSON.stringify(base()!.settings);
  const fill = (value: Settings) => { setSettings(value); setRules(value.patterns.join('\n')); setHosts(value.hosts.join('\n')); setResult(undefined); };
  const apply = (view: SettingsView) => { setBase(view); fill(view.settings); };
  const perform = async (action: () => Promise<void>) => {
    setError(''); setNotice(''); setBusy(true);
    try { await action(); } catch (failure) { if (live) setError(failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string' ? failure.message : 'Не удалось выполнить действие.'); }
    finally { if (live) setBusy(false); }
  };
  const load = () => perform(async () => { const view = await props.api.get(); if (live) apply(view); });
  onMount(load);
  const update = (key: keyof Diagnostics, value: boolean) => { setSettings(previous => ({ ...previous, diagnostics: { ...previous.diagnostics, [key]: value } })); setResult(undefined); };
  const importFile = (file: File) => perform(async () => {
    if (file.size > 8 * 1024 * 1024) throw new Error('Файл конфигурации превышает 8 МБ.');
    const imported = await props.api.importConfig(await file.text());
    if (!live) return;
    if (dirty() && !(props.confirmReplace ? await props.confirmReplace() : window.confirm('Заменить несохранённые изменения импортируемой конфигурацией?'))) return;
    if (!live) return;
    fill(imported);
    setNotice(dirty() ? 'Файл проверен. Для применения нажмите «Сохранить».' : 'Импортированная конфигурация совпадает с сохранённой.');
  });
  const saveFile = async (file: ConfigDocument): Promise<boolean> => {
    if (props.saveFile) return props.saveFile(file);
    else {
      const url = URL.createObjectURL(new Blob([file.content], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
  };
  const exportFile = () => perform(async () => { const file = await props.api.exportConfig(draft()); if (live && await saveFile(file) && live) setNotice('Конфигурация экспортирована.'); });
  const options: Array<{ key: keyof Diagnostics; title: string; description: string }> = [
    { key: 'logs', title: 'Маскировать логи', description: 'Применять словарь внутри найденных логов.' },
    { key: 'stacktraces', title: 'Маскировать стектрейсы', description: 'Применять словарь внутри найденных стектрейсов.' },
    { key: 'marked', title: 'Искать по разметке', description: 'Блоки log, console, traceback и соответствующие теги.' },
    { key: 'heuristics', title: 'Искать по структуре', description: 'Уровни логов, Logcat, Java/Kotlin, JavaScript и Python.' },
    { key: 'tool_output', title: 'Считать вывод инструментов логом', description: 'Распространять настройку логов на весь текст результата инструмента.' }
  ];
  return <div class="p4p-root">
    <header class="p4p-heading"><div><h1>p4p</h1><p>Маскирование перед отправкой модели</p></div><span class="p4p-badge">{settings().enabled ? 'Включён' : 'Выключен'}</span></header>
    <Show when={error()}><div role="alert" class="p4p-error">{error()}</div></Show>
    <Show when={notice()}><div role="status" class="p4p-notice">{notice()}</div></Show>
    <Show when={!base()}><button disabled={busy()} onClick={load}>{busy() ? 'Загрузка…' : 'Повторить загрузку'}</button></Show>
    <Show when={base()}>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => { const view = await props.api.save(draft(), base()!.revision); if (live) { apply(view); props.onSaved?.(view); setNotice('Сохранено. Правила применятся к следующим запросам.'); } }); }}>
        <fieldset disabled={busy()}>
          <div class="p4p-transfer">
            <div class="p4p-actions"><button type="button" onClick={() => fileInput?.click()}>Импорт JSON</button><button type="button" onClick={() => void exportFile()}>Экспорт JSON</button></div>
            <input ref={fileInput} type="file" accept=".json,application/json" aria-label="Файл конфигурации" hidden style={{ display: 'none' }} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file); }} />
            <small>Импорт заполняет форму; примените его кнопкой «Сохранить». Экспорт включает текущие поля, в том числе несохранённые изменения.</small>
          </div>
          <label class="p4p-check"><input type="checkbox" checked={settings().enabled} onChange={event => { setSettings(value => ({ ...value, enabled: event.currentTarget.checked })); setResult(undefined); }} />Включить маскирование</label>
          <section><h2>Словарь</h2><p id={`${uid}-rules-help`}>Одна строка — один паттерн Python regex. Обычные слова тоже подходят. Для любого регистра используйте (?i), для буквальной точки — \.</p>
            <label for={`${uid}-rules`}>Слова и регулярные выражения</label><textarea id={`${uid}-rules`} aria-describedby={`${uid}-rules-help`} spellcheck={false} rows={9} value={rules()} onInput={event => { setRules(event.currentTarget.value); setResult(undefined); }} placeholder={'example\n(?i)private\n[\\w.+-]+@example\\.test'} />
            <small>Паттернов: {lines(rules()).length} / 600. Пустые строки пропускаются.</small>
          </section>
          <section><h2>Хосты моделей</h2><p id={`${uid}-hosts-help`}>По одному хосту на строку: api.example.com, localhost:8080 или *.example.com. Можно вставить полный URL. Пустой список отключает обработку всех хостов.</p>
            <label for={`${uid}-hosts`}>Применять к хостам</label><textarea id={`${uid}-hosts`} aria-describedby={`${uid}-hosts-help`} spellcheck={false} rows={3} value={hosts()} onInput={event => { setHosts(event.currentTarget.value); setResult(undefined); }} placeholder={'api.example.com\nlocalhost:8080'} />
          </section>
          <section><h2>Логи и стектрейсы</h2><p>Словарь применяется внутри фрагментов, сохраняя остальной контекст. Если переключатель логов или стектрейсов выключен, найденные фрагменты этого типа отправляются без маскирования.</p>
            <For each={options}>{option => <label class="p4p-option"><input type="checkbox" checked={settings().diagnostics[option.key]} onChange={event => update(option.key, event.currentTarget.checked)} /><span>{option.title}<small>{option.description}</small></span></label>}</For>
          </section>
          <div class="p4p-actions"><button class="p4p-primary" type="submit" disabled={!dirty()}>Сохранить</button><button type="button" onClick={() => { if (!dirty() || window.confirm('Загрузить сохранённые настройки и отменить изменения в этом окне?')) void load(); }}>Перезагрузить</button><span>{dirty() ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}</span></div>
        </fieldset>
      </form>
      <section><h2>Предпросмотр</h2><p>Проверяет текущие поля, включая несохранённые изменения. Текст обрабатывается локально и не отправляется модели.</p>
        <label for={`${uid}-preview-host`}>URL модели для проверки хоста (необязательно)</label><input id={`${uid}-preview-host`} value={host()} onInput={event => { setHost(event.currentTarget.value); setResult(undefined); }} placeholder="https://api.example.com/v1" />
        <label for={`${uid}-preview-text`}>Текст для проверки</label><textarea id={`${uid}-preview-text`} rows={5} maxlength={256000} value={text()} onInput={event => { setText(event.currentTarget.value); setResult(undefined); }} />
        <button disabled={busy()} onClick={() => void perform(async () => { const value = await props.api.preview(draft(), text(), host()); if (live) setResult(value); })}>Проверить</button>
        <Show when={result()}>{value => <div class="p4p-results">
          <p role="status">Замен: {value().statistics.replacements} · Логов: {value().statistics.fragments.log} · Стектрейсов: {value().statistics.fragments.stacktrace}</p>
          <Show when={value().hostMatches !== null}><p>{value().hostMatches ? 'Хост входит в список.' : 'Хост не входит в список: реальный запрос останется без изменений.'}</p></Show>
          <label for={`${uid}-masked`}>После маскирования</label><textarea id={`${uid}-masked`} readonly rows={4} value={String(value().value)} />
          <label for={`${uid}-restored`}>После восстановления</label><textarea id={`${uid}-restored`} readonly rows={4} value={value().restored || ''} />
        </div>}</Show>
      </section>
      <FailureHistory api={props.api} saveFile={saveFile} confirmClear={props.confirmClear} />
      <footer>Настройки на сервере OpenCode: <code>{base()!.path}</code><p>HTTP/JSON, SSE и WebSocket Responses API. Изображения и вложения в бинарном виде не обрабатываются.</p></footer>
    </Show>
  </div>;
}

import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import type { Diagnostics, Settings, SettingsView, TransformResult } from './core/types.js';
import defaults from './core/defaults.json';

export interface BatyaApi {
  get(): Promise<SettingsView>;
  save(settings: Settings, revision: string): Promise<SettingsView>;
  preview(settings: Settings, text: string, host: string): Promise<Omit<TransformResult, 'mapping'> & { hostMatches: boolean | null }>;
}
export function Editor(props: { api: BatyaApi; onSaved?: (view: SettingsView) => void }) {
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
  const [result, setResult] = createSignal<Awaited<ReturnType<BatyaApi['preview']>>>();
  let live = true;
  onCleanup(() => { live = false; });
  const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const draft = (): Settings => ({ ...settings(), patterns: lines(rules()), hosts: lines(hosts()) });
  const dirty = () => !!base() && JSON.stringify(draft()) !== JSON.stringify(base()!.settings);
  const apply = (view: SettingsView) => { setBase(view); setSettings(view.settings); setRules(view.settings.patterns.join('\n')); setHosts(view.settings.hosts.join('\n')); setResult(undefined); };
  const perform = async (action: () => Promise<void>) => {
    setError(''); setNotice(''); setBusy(true);
    try { await action(); } catch (failure) { if (live) setError(failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string' ? failure.message : 'Не удалось выполнить действие.'); }
    finally { if (live) setBusy(false); }
  };
  const load = () => perform(async () => { const view = await props.api.get(); if (live) apply(view); });
  onMount(load);
  const update = (key: keyof Diagnostics, value: boolean) => { setSettings(previous => ({ ...previous, diagnostics: { ...previous.diagnostics, [key]: value } })); setResult(undefined); };
  const options: Array<{ key: keyof Diagnostics; title: string; description: string }> = [
    { key: 'logs', title: 'Маскировать логи', description: 'Применять словарь внутри найденных логов.' },
    { key: 'stacktraces', title: 'Маскировать стектрейсы', description: 'Применять словарь внутри найденных стектрейсов.' },
    { key: 'marked', title: 'Искать по разметке', description: 'Блоки log, console, traceback и соответствующие теги.' },
    { key: 'heuristics', title: 'Искать по структуре', description: 'Уровни логов, Logcat, Java/Kotlin, JavaScript и Python.' },
    { key: 'tool_output', title: 'Считать вывод инструментов логом', description: 'Распространять настройку логов на весь текст результата инструмента.' }
  ];
  return <div class="batya-root">
    <header class="batya-heading"><div><h1>Batya</h1><p>Маскирование перед отправкой модели</p></div><span class="batya-badge">{settings().enabled ? 'Включён' : 'Выключен'}</span></header>
    <Show when={error()}><div role="alert" class="batya-error">{error()}</div></Show>
    <Show when={notice()}><div role="status" class="batya-notice">{notice()}</div></Show>
    <Show when={!base()}><button disabled={busy()} onClick={load}>{busy() ? 'Загрузка…' : 'Повторить загрузку'}</button></Show>
    <Show when={base()}>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => { const view = await props.api.save(draft(), base()!.revision); if (live) { apply(view); props.onSaved?.(view); setNotice('Сохранено. Правила применятся к следующим запросам.'); } }); }}>
        <fieldset disabled={busy()}>
          <label class="batya-check"><input type="checkbox" checked={settings().enabled} onChange={event => { setSettings(value => ({ ...value, enabled: event.currentTarget.checked })); setResult(undefined); }} />Включить маскирование</label>
          <section><h2>Словарь</h2><p id={`${uid}-rules-help`}>Одна строка — один паттерн Python regex. Обычные слова тоже подходят. Для любого регистра используйте (?i), для буквальной точки — \.</p>
            <label for={`${uid}-rules`}>Слова и регулярные выражения</label><textarea id={`${uid}-rules`} aria-describedby={`${uid}-rules-help`} spellcheck={false} rows={9} value={rules()} onInput={event => { setRules(event.currentTarget.value); setResult(undefined); }} placeholder={'example\n(?i)private\n[\\w.+-]+@example\\.test'} />
            <small>Паттернов: {lines(rules()).length} / 600. Пустые строки пропускаются.</small>
          </section>
          <section><h2>Хосты моделей</h2><p id={`${uid}-hosts-help`}>По одному хосту на строку: api.example.com, localhost:8080 или *.example.com. Можно вставить полный URL. Пустой список отключает обработку всех хостов.</p>
            <label for={`${uid}-hosts`}>Применять к хостам</label><textarea id={`${uid}-hosts`} aria-describedby={`${uid}-hosts-help`} spellcheck={false} rows={3} value={hosts()} onInput={event => { setHosts(event.currentTarget.value); setResult(undefined); }} placeholder={'api.example.com\nlocalhost:8080'} />
          </section>
          <section><h2>Логи и стектрейсы</h2><p>Словарь применяется внутри фрагментов, сохраняя остальной контекст. Если переключатель логов или стектрейсов выключен, найденные фрагменты этого типа отправляются без маскирования.</p>
            <For each={options}>{option => <label class="batya-option"><input type="checkbox" checked={settings().diagnostics[option.key]} onChange={event => update(option.key, event.currentTarget.checked)} /><span>{option.title}<small>{option.description}</small></span></label>}</For>
          </section>
          <div class="batya-actions"><button class="batya-primary" type="submit" disabled={!dirty()}>Сохранить</button><button type="button" onClick={() => { if (!dirty() || window.confirm('Загрузить сохранённые настройки и отменить изменения в этом окне?')) void load(); }}>Перезагрузить</button><span>{dirty() ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}</span></div>
        </fieldset>
      </form>
      <section><h2>Предпросмотр</h2><p>Проверяет текущие поля, включая несохранённые изменения. Текст обрабатывается локально и не отправляется модели.</p>
        <label for={`${uid}-preview-host`}>URL модели для проверки хоста (необязательно)</label><input id={`${uid}-preview-host`} value={host()} onInput={event => { setHost(event.currentTarget.value); setResult(undefined); }} placeholder="https://api.example.com/v1" />
        <label for={`${uid}-preview-text`}>Текст для проверки</label><textarea id={`${uid}-preview-text`} rows={5} maxlength={256000} value={text()} onInput={event => { setText(event.currentTarget.value); setResult(undefined); }} />
        <button disabled={busy()} onClick={() => void perform(async () => { const value = await props.api.preview(draft(), text(), host()); if (live) setResult(value); })}>Проверить</button>
        <Show when={result()}>{value => <div class="batya-results">
          <p role="status">Замен: {value().statistics.replacements} · Логов: {value().statistics.fragments.log} · Стектрейсов: {value().statistics.fragments.stacktrace}</p>
          <Show when={value().hostMatches !== null}><p>{value().hostMatches ? 'Хост входит в список.' : 'Хост не входит в список: реальный запрос останется без изменений.'}</p></Show>
          <label for={`${uid}-masked`}>После маскирования</label><textarea id={`${uid}-masked`} readonly rows={4} value={String(value().value)} />
          <label for={`${uid}-restored`}>После восстановления</label><textarea id={`${uid}-restored`} readonly rows={4} value={value().restored || ''} />
        </div>}</Show>
      </section>
      <footer>Настройки на сервере OpenCode: <code>{base()!.path}</code><p>HTTP/JSON, SSE и WebSocket Responses API. Изображения и вложения в бинарном виде не обрабатываются.</p></footer>
    </Show>
  </div>;
}

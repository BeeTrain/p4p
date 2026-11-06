import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { FailureSummary } from './core/failures.js';
import type { ConfigDocument } from './core/config-transfer.js';

export interface FailureApi {
  listFailures(): Promise<{ rows: FailureSummary[]; storage_error: string }>;
  exportFailure(id: string): Promise<ConfigDocument>;
  clearFailures(): Promise<unknown>;
}
export function FailureHistory(props: { api: FailureApi; saveFile: (file: ConfigDocument) => Promise<boolean>; confirmClear?: () => Promise<boolean> }) {
  const [rows, setRows] = createSignal<FailureSummary[]>([]);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  let live = true, loading = false;
  const message = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Не удалось выполнить действие.';
  const load = async () => {
    if (!live || loading || busy()) return;
    loading = true;
    try { const value = await props.api.listFailures(); if (live) { setRows(value.rows); setError(value.storage_error); setLoaded(true); } }
    catch (error) { if (live) setError(message(error)); }
    finally { loading = false; }
  };
  const download = async (id: string) => {
    setBusy(true); setError('');
    try { const file = await props.api.exportFailure(id); if (live) await props.saveFile(file); }
    catch (error) { if (live) setError(message(error)); }
    finally { if (live) setBusy(false); }
  };
  const clear = async () => {
    if (!(props.confirmClear ? await props.confirmClear() : window.confirm('Удалить сохранённые неуспешные запросы?'))) return;
    setBusy(true); setError('');
    try { await props.api.clearFailures(); if (live) setRows([]); }
    catch (error) { if (live) setError(message(error)); }
    finally { if (live) setBusy(false); }
  };
  onMount(() => void load());
  const timer = setInterval(() => void load(), 3000);
  onCleanup(() => { live = false; clearInterval(timer); });
  const errorText = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && 'message' in value ? String(value.message) : JSON.stringify(value);
  return <section class="p4p-failures" aria-label="Неуспешные запросы">
    <h2>Неуспешные запросы</h2><p>Ошибки следующих запросов при включённом p4p для выбранных хостов. JSON содержит тело запроса, ошибку и доступные метрики; известные секреты скрыты. Показываются последние 50 ошибок за семь дней.</p>
    <div class="p4p-actions"><button disabled={busy()} onClick={() => void load()}>Обновить запросы</button><button disabled={busy() || !rows().length} onClick={() => void clear()}>Очистить журнал</button></div>
    <Show when={error()}><div role="alert" class="p4p-error">{error()}</div></Show>
    <Show when={loaded() && !rows().length}><p>Неуспешных запросов пока нет.</p></Show>
    <For each={rows()}>{row => <article class="p4p-failure-row">
      <div><strong>{row.model}</strong> · {row.http_status ? `HTTP ${row.http_status}` : row.source === 'websocket' ? 'WebSocket' : 'Ошибка запроса'}</div>
      <small>{new Date(row.started_at * 1000).toLocaleString()} · {row.provider} · {row.operation} · {row.session_id}</small>
      <p>{errorText(row.error)}</p><button disabled={busy()} aria-label={`Скачать JSON запроса ${row.id}`} onClick={() => void download(row.id)}>Скачать JSON</button>
    </article>}</For>
  </section>;
}

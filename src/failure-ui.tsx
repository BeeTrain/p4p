import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { FailureSummary, RequestStatus } from './core/failures.js';
import type { ConfigDocument } from './core/config-transfer.js';
import { SectionHeading } from './help.js';

export interface FailureApi {
  listFailures(): Promise<{ rows: FailureSummary[]; storage_error: string }>;
  exportFailure(id: string): Promise<ConfigDocument>;
  clearFailures(): Promise<unknown>;
}
export function FailureHistory(props: { api: FailureApi; saveFile: (file: ConfigDocument) => Promise<boolean>; confirmClear?: () => Promise<boolean>; recording: boolean; savedRecording: boolean; disabled?: boolean; onRecordingChange: (enabled: boolean) => void }) {
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
    if (!(props.confirmClear ? await props.confirmClear() : window.confirm('Удалить сохранённые запросы из журнала?'))) return;
    setBusy(true); setError('');
    try { await props.api.clearFailures(); if (live) setRows([]); }
    catch (error) { if (live) setError(message(error)); }
    finally { if (live) setBusy(false); }
  };
  onMount(() => void load());
  const timer = setInterval(() => void load(), 3000);
  onCleanup(() => { live = false; clearInterval(timer); });
  const labels: Record<RequestStatus, string> = { succeeded: 'Успешно', failed: 'Ошибка', unknown: 'Без результата' };
  const errorText = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && 'message' in value ? String(value.message) : JSON.stringify(value ?? '');
  const detail = (row: FailureSummary) => row.error ? errorText(row.error) : row.http_status ? `HTTP ${row.http_status}` : row.source === 'websocket' ? 'WebSocket' : 'Ответ не получен';
  return <section class="p4p-failures" aria-label="Журнал запросов">
    <SectionHeading title="Журнал запросов" help="Последние 50 запросов за семь дней при включённом p4p для выбранных хостов. Зелёный — завершён успешно, красный — ошибка, оранжевый — выполняется или завершение не подтверждено. JSON содержит запрос и доступные метрики; известные секреты скрыты." />
    <div class="p4p-journal-toolbar">
      <label class="p4p-check p4p-toggle"><input type="checkbox" checked={props.recording} disabled={props.disabled} onChange={event => props.onRecordingChange(event.currentTarget.checked)} /><span>Записывать запросы</span></label>
      <div class="p4p-actions"><button disabled={busy()} onClick={() => void load()}>Обновить запросы</button><button class="p4p-danger-quiet" disabled={busy() || !rows().length} onClick={() => void clear()}>Очистить журнал</button></div>
    </div>
    <Show when={props.recording !== props.savedRecording}><small>Изменение записи применится после сохранения настроек.</small></Show>
    <Show when={!props.savedRecording}><small>Запись выключена. Сохранённые запросы доступны для просмотра и экспорта.</small></Show>
    <Show when={error()}><div role="alert" class="p4p-error">{error()}</div></Show>
    <Show when={loaded() && !rows().length}><p class="p4p-empty">В журнале пока нет запросов.</p></Show>
    <Show when={rows().length}>
      <div class="p4p-journal-scroll" tabindex="0" aria-label="Список запросов">
        <table class="p4p-journal-table">
          <thead><tr><th scope="col">Статус</th><th scope="col">Время</th><th scope="col">Модель</th><th scope="col">Результат</th><th scope="col"><span class="p4p-sr-only">Экспорт</span></th></tr></thead>
          <tbody><For each={rows()}>{row => <tr class="p4p-failure-row">
            <td><span class="p4p-request-status" data-status={row.status}><span class="p4p-status-light" aria-hidden="true" />{labels[row.status] ?? labels.unknown}</span></td>
            <td><time datetime={new Date(row.started_at * 1000).toISOString()} title={new Date(row.started_at * 1000).toLocaleString('ru-RU')}>{new Date(row.started_at * 1000).toLocaleTimeString('ru-RU', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></td>
            <td class="p4p-model-cell" title={`${row.model} · ${row.provider} · ${row.operation} · ${row.session_id}`}>{row.model || 'Неизвестная модель'}</td>
            <td class="p4p-result-cell" title={detail(row)}>{row.http_status ? `HTTP ${row.http_status}` : ''}{row.error ? `${row.http_status ? ' · ' : ''}${errorText(row.error)}` : row.http_status ? '' : detail(row)}</td>
            <td><button class="p4p-download" disabled={busy()} aria-label={`Скачать JSON запроса ${row.id}`} onClick={() => void download(row.id)}>JSON ↓</button></td>
          </tr>}</For></tbody>
        </table>
      </div>
      <small class="p4p-journal-count">Записей: {rows().length} / 50 · Обновление каждые 3 секунды</small>
    </Show>
  </section>;
}

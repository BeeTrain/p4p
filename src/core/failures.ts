import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import type { ConfigDocument } from './config-transfer.js';

export interface RequestIdentity { sessionID: string; agent: string; model: { providerID: string; id: string; variant?: string }; kind?: string }
export interface FailedRequest {
  id: string; source: 'http' | 'websocket' | 'transcript'; status: 'failed'; session_id: string; provider: string; model: string; role: string; operation: string;
  started_at: number; ended_at?: number; duration_seconds?: number; endpoint: string; request: unknown; masked_request?: unknown;
  error?: unknown; response_preview?: string; http_status?: number; coverage: string; attempt: number; previous_request_id: string | null;
  [key: string]: unknown;
}
export type FailureSummary = Pick<FailedRequest, 'id' | 'source' | 'status' | 'session_id' | 'provider' | 'model' | 'role' | 'operation' | 'started_at' | 'http_status' | 'error'>;
const idPattern = /^[a-f0-9]{24}$/;
const secretKey = /authorization|api[-_]?key|(?:access|refresh)[-_]?token|password|secret|cookie/i;
export function redactDiagnostic(value: unknown, secrets: string[] = [], depth = 0): any {
  if (depth > 64) return '[TRUNCATED: nesting limit]';
  if (typeof value === 'string') {
    let text = value.replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]').replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
    text = text.replace(/((?:api[-_]?key|(?:access|refresh)[-_]?token|password|secret)["']?\s*[=:]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2');
    text = text.replace(/((?:["']?(?:api[-_]?key|(?:access|refresh)[-_]?token|password|secret)["']?)\s*[=:]\s*["']?)[^\s,"'<>]+/gi, '$1[REDACTED]');
    for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.slice(0, 100000).map(item => redactDiagnostic(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100000).map(([key, item]) => [redactDiagnostic(key, secrets, depth + 1), secretKey.test(key) ? '[REDACTED]' : redactDiagnostic(item, secrets, depth + 1)]));
  return value;
}
export function endpointOf(address: string): string {
  try { const url = new URL(address); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return '[недоступен]'; }
}
export function credentials(address: string, headers: Headers | Record<string, string>): string[] {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const values = entries.filter(([name]) => secretKey.test(name)).flatMap(([, value]) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]);
  try { const url = new URL(address); values.push(decodeURIComponent(url.username), decodeURIComponent(url.password)); for (const [key, value] of url.searchParams) if (secretKey.test(key)) values.push(value); } catch {}
  return [...new Set(values.filter(Boolean))];
}
export function requestShape(payload: any): Record<string, unknown> {
  const messages = payload?.messages ?? payload?.input;
  return { stream: payload?.stream ?? false, message_count: Array.isArray(messages) ? messages.length : null, tool_count: Array.isArray(payload?.tools) ? payload.tools.length : null, max_output_tokens: payload?.max_output_tokens ?? payload?.max_completion_tokens ?? payload?.max_tokens ?? null };
}
export function usageOf(value: any): Record<string, number> {
  const usage = value?.usage ?? value?.response?.usage;
  if (!usage || typeof usage !== 'object') return {};
  return Object.fromEntries(Object.entries({ input_tokens: usage.input_tokens ?? usage.prompt_tokens, cached_input_tokens: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens, output_tokens: usage.output_tokens ?? usage.completion_tokens, reasoning_output_tokens: usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens }).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}
export class FailureStore {
  readonly path: string;
  error = '';
  private queue = Promise.resolve();
  private summaries = new Map<string, { at: number; size: number; row: FailureSummary }>();
  constructor(configPath: string) { this.path = join(dirname(configPath), 'failed-requests', createHash('sha256').update(basename(configPath)).digest('hex').slice(0, 16)); }
  private async files(): Promise<Array<{ name: string; size: number; at: number }>> {
    let names: string[];
    try { names = await readdir(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const files = await Promise.all(names.filter(name => /^[a-f0-9]{24}\.json$/.test(name)).map(async name => {
      try { const info = await lstat(join(this.path, name)); return info.isFile() ? { name, size: info.size, at: info.mtimeMs } : undefined; } catch { return undefined; }
    }));
    return files.filter((file): file is NonNullable<typeof file> => !!file).sort((a, b) => b.at - a.at);
  }
  async write(record: FailedRequest): Promise<void> {
    const operation = this.queue.then(async () => {
      if (!idPattern.test(record.id)) throw new Error('Неверный идентификатор запроса.');
      await mkdir(this.path, { recursive: true, mode: 0o700 });
      const target = join(this.path, record.id + '.json'), temporary = target + '.' + randomBytes(6).toString('hex') + '.tmp';
      let value = redactDiagnostic(record);
      let content = JSON.stringify(value);
      if (Buffer.byteLength(content) > 36 * 1024 * 1024) {
        value = { ...value, request: null, masked_request: null, coverage: value.coverage + ' Тело не сохранено: запись превышает 36 МБ.' };
        content = JSON.stringify(value);
      }
      try { await writeFile(temporary, content + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
      finally { this.summaries.delete(record.id); await unlink(temporary).catch(() => {}); }
      let size = 0, count = 0;
      for (const file of await this.files()) {
        size += file.size; count++;
        if (count > 50 || size > 128 * 1024 * 1024 || Date.now() - file.at > 7 * 86400000) await unlink(join(this.path, file.name)).catch(() => {});
      }
      this.error = '';
    });
    this.queue = operation.catch(error => { this.error = error instanceof Error ? error.message : 'Не удалось сохранить журнал ошибок.'; });
    await this.queue;
  }
  async listing(): Promise<{ rows: FailureSummary[]; storage_error: string }> {
    await this.queue;
    const rows: FailureSummary[] = [];
    const files = (await this.files()).slice(0, 50), present = new Set(files.map(file => file.name.slice(0, -5)));
    for (const id of this.summaries.keys()) if (!present.has(id)) this.summaries.delete(id);
    for (const file of files) {
      if (Date.now() - file.at > 7 * 86400000) { await unlink(join(this.path, file.name)).catch(() => {}); continue; }
      const id = file.name.slice(0, -5), cached = this.summaries.get(id);
      if (cached?.at === file.at && cached.size === file.size) { rows.push(cached.row); continue; }
      const row = await this.read(id).catch(() => undefined);
      if (row) {
        const { id, source, status, session_id, provider, model, role, operation, started_at, http_status, error } = row;
        const summary = { id, source, status, session_id, provider, model, role, operation, started_at, http_status, error: (typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : JSON.stringify(error) ?? '').slice(0, 2000) };
        this.summaries.set(id, { at: file.at, size: file.size, row: summary }); rows.push(summary);
      }
    }
    return { rows, storage_error: this.error };
  }
  async read(id: string): Promise<FailedRequest> {
    if (!idPattern.test(id)) throw new Error('Неверный идентификатор запроса.');
    await this.queue;
    const file = join(this.path, id + '.json'), info = await lstat(file);
    if (!info.isFile() || info.size > 36 * 1024 * 1024) throw new Error('Запись запроса недоступна.');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.id !== id || value.status !== 'failed') throw new Error('Некорректная запись запроса.');
    return redactDiagnostic(value);
  }
  async export(id: string): Promise<ConfigDocument> { return { name: `model-request-${id}.json`, content: JSON.stringify(await this.read(id), null, 2) + '\n' }; }
  async clear(): Promise<void> { await this.queue; for (const file of await this.files()) await unlink(join(this.path, file.name)); this.summaries.clear(); }
  async flush(): Promise<void> { await this.queue; }
}
export interface Ticket { row: FailedRequest; secrets: string[]; closed: boolean; done: boolean; bytes: number }
export class FailureTickets {
  readonly pending = new Map<string, Ticket>();
  private attempts = new Map<string, { count: number; id: string }>();
  constructor(readonly store: FailureStore) {}
  begin(identity: RequestIdentity, source: 'http' | 'websocket' | 'transcript', address: string, secretValues: string[], request: unknown, bytes: number): Ticket {
    this.sweep();
    for (const [id, ticket] of this.pending) if (ticket.done && ticket.row.session_id === identity.sessionID && ticket.row.operation === identity.kind) this.pending.delete(id);
    const id = randomBytes(12).toString('hex');
    const row: FailedRequest = { id, source, status: 'failed', session_id: identity.sessionID, provider: identity.model.providerID, model: identity.model.id, role: identity.agent, operation: identity.kind ?? 'primary', effort: identity.model.variant ?? null, endpoint: endpointOf(address), started_at: Date.now() / 1000, request: redactDiagnostic(request, secretValues), request_bytes: bytes, ...requestShape(request), job: null, phase: null, context_tokens: null, context_window: null, invocation: {}, command: {}, agent_elapsed_seconds: null, prompt: null, prompt_note: 'Промпт запуска роли недоступен в плагине OpenCode; запрос модели находится в поле request.', coverage: 'Тело запроса OpenCode до маскирования; известные поля секретов скрыты. Метрики, недоступные плагину, равны null.', attempt: 1, previous_request_id: null };
    const hash = createHash('sha256').update(JSON.stringify([identity.sessionID, identity.agent, identity.model, identity.kind, request])).digest('hex');
    const previous = this.attempts.get(hash); row.request_hash = hash; row.attempt = (previous?.count ?? 0) + 1; row.previous_request_id = previous?.id ?? null;
    this.attempts.set(hash, { count: row.attempt, id });
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value!);
    const ticket = { row, secrets: secretValues, closed: false, done: false, bytes };
    this.pending.set(id, ticket);
    let total = 0;
    for (const current of [...this.pending.values()].reverse()) {
      total += current.bytes;
      if (total > 64 * 1024 * 1024) { current.row.request = null; current.row.masked_request = null; current.row.coverage += ' Тело освобождено из-за лимита памяти журнала.'; current.bytes = 0; }
    }
    while (this.pending.size > 128) { const first = this.pending.keys().next().value!; const old = this.pending.get(first)!; old.row.request = null; old.row.masked_request = null; old.bytes = 0; old.row.coverage += ' Тело освобождено из-за лимита активных записей.'; this.pending.delete(first); }
    return ticket;
  }
  sent(ticket: Ticket | undefined, value: unknown, bytes: number, masking?: unknown): void {
    if (!ticket || ticket.closed) return;
    if (!ticket.bytes) { ticket.row.upstream_request_bytes = bytes; return; }
    ticket.row.masked_request = redactDiagnostic(value, ticket.secrets); ticket.row.upstream_request_bytes = bytes;
    if (masking) ticket.row.masking = masking;
  }
  async fail(ticket: Ticket | undefined, error: unknown, preview?: unknown, status?: number): Promise<void> {
    if (!ticket || ticket.closed) return;
    ticket.closed = true; this.pending.delete(ticket.row.id);
    const ended = Date.now() / 1000;
    const detail = error instanceof Error ? { type: error.name, message: error.message } : error;
    const responseText = typeof preview === 'string' ? preview : JSON.stringify(preview ?? '');
    const row = { ...ticket.row, ended_at: ended, duration_seconds: ended - ticket.row.started_at, error: redactDiagnostic(detail, ticket.secrets), response_preview: redactDiagnostic(responseText?.slice(0, 16000) ?? '', ticket.secrets), ...(status ? { http_status: status } : {}) };
    await this.store.write(row);
    ticket.secrets = []; ticket.row.request = null; ticket.row.masked_request = null;
  }
  async error(identity: Partial<RequestIdentity> & { sessionID: string }, error: any): Promise<void> {
    const matches = [...this.pending.values()].filter(ticket => ticket.row.session_id === identity.sessionID && (!identity.agent || ticket.row.role === identity.agent) && (!identity.model || ticket.row.model === identity.model.id && ticket.row.provider === identity.model.providerID));
    if (matches.length === 1) await this.fail(matches[0], error, error?.response?.body, error?.status);
    else if (matches.length > 1) {
      const ticket = this.begin({ sessionID: identity.sessionID, agent: identity.agent ?? '', model: identity.model ?? { providerID: '', id: '' } }, 'transcript', '', [...new Set(matches.flatMap(item => item.secrets))], null, 0);
      ticket.row.coverage = 'Событие ошибки OpenCode нельзя однозначно сопоставить с параллельными запросами. Тело запроса не подставлено.';
      ticket.row.candidate_request_ids = matches.map(item => item.row.id);
      await this.fail(ticket, error, error?.response?.body, error?.status);
    }
  }
  finish(sessionID: string): void { for (const [id, ticket] of this.pending) if (ticket.row.session_id === sessionID) { ticket.closed = true; ticket.row.request = null; ticket.row.masked_request = null; ticket.secrets = []; this.pending.delete(id); } }
  private sweep(): void { for (const [id, ticket] of this.pending) if (Date.now() / 1000 - ticket.row.started_at > 3600) { ticket.closed = true; ticket.row.request = null; ticket.row.masked_request = null; ticket.secrets = []; this.pending.delete(id); } }
}

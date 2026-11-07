import { gunzipSync } from 'node:zlib';
import { FailureStore, FailureTickets, credentials, usageOf, type RequestIdentity, type Ticket } from './failures.js';
import { SettingsStore } from './settings.js';
import { matchesHost } from './hosts.js';

const identityKey = (value: RequestIdentity) => JSON.stringify([value.sessionID, value.agent, value.model.providerID, value.model.id, value.model.variant, value.kind ?? 'primary']);
async function readBody(body: ReadableStream<Uint8Array> | null, limit: number, timeout = 3000): Promise<{ text: string; bytes: Buffer; truncated: boolean }> {
  if (!body) return { text: '', bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader(), chunks: Buffer[] = [];
  let size = 0, truncated = false;
  const timer = setTimeout(() => { truncated = true; void reader.cancel().catch(() => {}); }, timeout);
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      const portion = chunk.value.slice(0, Math.max(0, limit - size)); chunks.push(Buffer.from(portion)); size += portion.length;
      if (chunk.value.length > portion.length || size >= limit) { truncated = true; void reader.cancel().catch(() => {}); break; }
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks); return { text: bytes.toString('utf8'), bytes, truncated };
}
const jsonOrText = (text: string): any => { try { return JSON.parse(text); } catch { return { body: text }; } };
export class FailureCapture {
  readonly tickets: FailureTickets;
  private requests = new WeakMap<Request, Ticket>();
  private sockets = new Map<string, { url: string; secrets: string[]; identity: RequestIdentity }>();
  private lanes = new Map<string, Ticket>();
  constructor(readonly settings: SettingsStore, readonly store: FailureStore) { this.tickets = new FailureTickets(store); }
  private async selected(url: string): Promise<boolean> { const { settings } = await this.settings.read(); return settings.enabled && settings.recordRequests && matchesHost(url, settings.hosts); }
  async httpStart(event: RequestIdentity & { request: Request }): Promise<Ticket | undefined> {
    for (const [id, old] of this.tickets.pending) if (old.done && old.row.session_id === event.sessionID && old.row.role === event.agent && old.row.model === event.model.id) { old.closed = true; old.row.request = null; old.row.masked_request = null; old.secrets = []; this.tickets.pending.delete(id); }
    if (!await this.selected(event.request.url)) return;
    const body = await readBody(event.request.clone().body, 16 * 1024 * 1024, 10000);
    const ticket = this.tickets.begin(event, 'http', event.request.url, credentials(event.request.url, event.request.headers), jsonOrText(body.text), Buffer.byteLength(body.text), false);
    ticket.row.method = event.request.method;
    if (body.truncated) ticket.row.coverage += ' Тело запроса усечено до 16 МБ или по таймауту чтения.';
    this.requests.set(event.request, ticket); await this.tickets.record(ticket); return ticket;
  }
  async httpSent(ticket: Ticket | undefined, request: Request, statistics?: unknown): Promise<void> {
    if (!ticket) return;
    this.requests.set(request, ticket);
    const body = await readBody(request.clone().body, 16 * 1024 * 1024, 10000);
    this.tickets.sent(ticket, jsonOrText(body.text), Buffer.byteLength(body.text), statistics);
    await this.store.flush();
  }
  async httpResponse(request: Request, response: Response): Promise<void> {
    const ticket = this.requests.get(request); if (!ticket || ticket.closed) return;
    ticket.row.http_status = response.status;
    ticket.row.first_byte_seconds = Date.now() / 1000 - ticket.row.started_at;
    if (response.status < 400) {
      if (!response.body) await this.tickets.complete(ticket, response.ok ? 'succeeded' : 'unknown');
      else await this.tickets.record(ticket);
      return;
    }
    let preview = '';
    try {
      const raw = await readBody(response.clone().body, 64000);
      preview = raw.bytes[0] === 0x1f && raw.bytes[1] === 0x8b ? gunzipSync(raw.bytes, { maxOutputLength: 16000 }).toString('utf8') : raw.text.slice(0, 16000);
    } catch { ticket.row.coverage += ' Ответ ошибки не удалось полностью прочитать или распаковать.'; }
    const value = jsonOrText(preview);
    await this.tickets.fail(ticket, value.error ?? { type: 'http', message: `HTTP ${response.status} ${response.statusText}` }, preview, response.status);
  }
  observe(request: Request, response: Response): Response {
    const ticket = this.requests.get(request);
    if (!ticket || ticket.closed || !response.body) return response;
    const reader = response.body.getReader();
    const type = response.headers.get('content-type') || '';
    const decoder = new TextDecoder(); let buffer = '', preview = '';
    let cancelled = false, completed = false;
    const markCompleted = () => { completed = true; if (response.ok && !ticket.closed) ticket.row.status = 'succeeded'; };
    const observe = async (text: string, final = false) => {
      preview = (preview + text).slice(0, 16000);
      buffer += text;
      const inspect = async (value: any, errorEvent = false) => {
        const tokens = usageOf(value); if (Object.keys(tokens).length) { ticket.row.tokens = tokens; ticket.row.context_tokens = tokens.input_tokens ?? null; }
        if (errorEvent || value?.error || ['error', 'response.failed'].includes(value?.type)) await this.tickets.fail(ticket, value.error ?? value.response?.error ?? value, preview, response.status);
        if (value?.type === 'response.completed' || value?.choices?.some((choice: any) => choice.finish_reason != null)) markCompleted();
      };
      if (type.includes('text/event-stream')) {
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer); if (!boundary) break;
          const raw = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const text = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (text === '[DONE]') markCompleted();
          else if (text) { try { await inspect(JSON.parse(text), /^event:\s*(?:error|response\.failed)\s*$/m.test(raw)); } catch {} }
        }
        if (final && buffer.trim()) { const text = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); try { if (text === '[DONE]') markCompleted(); else await inspect(JSON.parse(text)); } catch {} buffer = ''; }
      } else if (final && type.includes('json')) { try { await inspect(JSON.parse(buffer)); markCompleted(); } catch {} }
      if (buffer.length > 1024 * 1024) buffer = '';
      if (final) ticket.done = true;
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const chunk = await reader.read();
          if (cancelled) return;
          if (chunk.done) { await observe(decoder.decode(), true); if (!cancelled) { await this.tickets.complete(ticket, completed && response.ok ? 'succeeded' : 'unknown', preview); if (!cancelled) controller.close(); } }
          else { await observe(decoder.decode(chunk.value, { stream: true })); if (!cancelled) controller.enqueue(chunk.value); }
        } catch (error) {
          if (cancelled) return;
          await this.tickets.fail(ticket, error, preview, response.status);
          if (!cancelled) controller.error(error);
        }
      },
      cancel: async reason => {
        cancelled = true; ticket.done = true;
        try { await reader.cancel(reason); }
        finally { await this.tickets.complete(ticket, completed && response.ok ? 'succeeded' : 'unknown', preview); }
      }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  async httpFailure(request: Request, error: unknown): Promise<void> { await this.tickets.fail(this.requests.get(request), error); }
  async wsHandshake(event: RequestIdentity & { url: string; headers: Record<string, string> }): Promise<void> {
    const key = identityKey(event);
    this.sockets.set(key, { url: event.url, secrets: credentials(event.url, event.headers), identity: { sessionID: event.sessionID, agent: event.agent, model: event.model, kind: event.kind } });
    if (!await this.selected(event.url)) return;
    const ticket = this.tickets.begin(event, 'websocket', event.url, credentials(event.url, event.headers), null, 0, false);
    ticket.row.coverage = 'Подключение WebSocket; сообщение response.create ещё не отправлено. Известные секреты скрыты.';
    this.lanes.set(key + '\n', ticket);
  }
  async wsStart(event: RequestIdentity & { frame: string }): Promise<Ticket | undefined> {
    const key = identityKey(event), socket = this.sockets.get(key); if (!socket) return;
    if (!await this.selected(socket.url)) return;
    const value = jsonOrText(event.frame); if (value.type !== 'response.create') return;
    const lane = typeof value.stream_id === 'string' ? value.stream_id : '';
    const previous = this.lanes.get(key + '\n' + lane);
    if (previous && previous.row.request === null) this.tickets.pending.delete(previous.row.id);
    const ticket = this.tickets.begin(event, 'websocket', socket.url, socket.secrets, value, Buffer.byteLength(event.frame), false);
    ticket.row.stream = true; ticket.row.coverage = 'Сообщение WebSocket response.create; известные секреты скрыты.' + (value.previous_response_id ? ' Инкрементальное продолжение: прошлый контекст хранится у модели и не входит в это сообщение.' : ''); this.lanes.set(key + '\n' + lane, ticket); await this.tickets.record(ticket); return ticket;
  }
  wsSent(ticket: Ticket | undefined, frame: string, statistics?: unknown): void { this.tickets.sent(ticket, jsonOrText(frame), Buffer.byteLength(frame), statistics); }
  async wsReceive(event: RequestIdentity & { frame: string }): Promise<void> {
    const value = jsonOrText(event.frame), lane = typeof value.stream_id === 'string' ? value.stream_id : '';
    const ticket = this.lanes.get(identityKey(event) + '\n' + lane); if (!ticket || ticket.closed) return;
    const tokens = usageOf(value); if (Object.keys(tokens).length) { ticket.row.tokens = tokens; ticket.row.context_tokens = tokens.input_tokens ?? null; }
    if (value.error || ['error', 'response.failed'].includes(value.type)) {
      const error = value.error ?? value.response?.error ?? value;
      const status = Number(error?.status ?? error?.status_code ?? value.status);
      await this.tickets.fail(ticket, error, event.frame, status >= 400 && status <= 599 ? status : undefined);
    } else if (['response.completed', 'response.incomplete', 'response.cancelled'].includes(value.type)) {
      await this.tickets.complete(ticket, value.type === 'response.completed' ? 'succeeded' : 'unknown', event.frame);
      this.lanes.delete(identityKey(event) + '\n' + lane);
    }
  }
  async wsFailure(identity: RequestIdentity, error: unknown): Promise<void> { await this.tickets.error(identity, error); }
  async retry(event: RequestIdentity & { error: unknown }): Promise<void> { await this.tickets.error(event, event.error); }
  async failed(sessionID: string, error: unknown): Promise<void> { await this.tickets.error({ sessionID }, error); this.finish(sessionID); }
  finish(sessionID: string, removeSockets = false): void {
    this.tickets.finish(sessionID);
    for (const [key, ticket] of this.lanes) if (ticket.row.session_id === sessionID) this.lanes.delete(key);
    if (removeSockets) for (const [key, socket] of this.sockets) if (socket.identity.sessionID === sessionID) this.sockets.delete(key);
  }
  async dispose(): Promise<void> { for (const ticket of this.tickets.pending.values()) this.tickets.finish(ticket.row.session_id); this.lanes.clear(); this.sockets.clear(); await this.store.flush(); }
}

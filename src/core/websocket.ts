import { createHash } from 'node:crypto';
import { SettingsStore } from './settings.js';
import { matchesHost } from './hosts.js';
import { maskRequest, validatePatterns } from './engine.js';
import { ResponsesDecoder } from './ws-decoder.js';
import type { Settings, Statistics } from './types.js';

export interface WebSocketIdentity {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { providerID: string; id: string; variant?: string };
  readonly kind: string;
}
export interface WebSocketHandshake extends WebSocketIdentity { url: string; headers: Record<string, string> }
export interface WebSocketFrame extends WebSocketIdentity { frame: string }
interface Context {
  sessionID: string;
  fingerprint: string;
  selected: boolean;
  settings: Settings;
  mapping: Record<string, string>;
  responses: Set<string>;
  decoder: ResponsesDecoder;
  touched: number;
  bytes: number;
  queue: Promise<void>;
  inFlight: boolean;
  lanes: Set<string>;
}
const keyOf = (event: WebSocketIdentity) => JSON.stringify([event.sessionID, event.agent, event.model.providerID, event.model.id, event.model.variant ?? '', event.kind]);
const parseFrame = (text: string): Record<string, any> => {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('p4p: сообщение WebSocket превышает 16 МБ.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('p4p: ожидается сообщение WebSocket в формате JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('p4p: сообщение WebSocket должно быть объектом JSON.');
  return value as Record<string, any>;
};

export class WebSocketMaskingTransport {
  private closed = false;
  private contexts = new Map<string, Context>();
  private validation?: { revision: string; pending: Promise<void> };
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly store: SettingsStore, private now = Date.now, readonly idleTTL = 60 * 60 * 1000) {
    this.timer = setInterval(() => this.expire(), Math.min(idleTTL, 60000));
    this.timer.unref();
  }
  private ensureOpen(): void { if (this.closed) throw new Error('p4p: обработчик WebSocket остановлен. Перезапустите OpenCode.'); }
  private expire(): void { for (const [key, value] of this.contexts) if (!value.inFlight && this.now() - value.touched > this.idleTTL) this.contexts.delete(key); }
  async handshake(event: WebSocketHandshake): Promise<void> {
    this.ensureOpen();
    const { settings, revision } = await this.store.read();
    this.expire();
    const selected = settings.enabled && settings.patterns.length > 0 && matchesHost(event.url, settings.hosts);
    if (selected) {
      if (this.validation?.revision !== revision) this.validation = { revision, pending: validatePatterns(settings) };
      await this.validation.pending;
    }
    const key = keyOf(event);
    const fingerprint = createHash('sha256').update(JSON.stringify([event.url, Object.entries(event.headers).map(([name, value]) => [name.toLowerCase(), value]).sort()])).digest('hex');
    let context = this.contexts.get(key);
    if (context && context.fingerprint !== fingerprint) { this.contexts.delete(key); context = undefined; }
    if (!context && !selected) return;
    if (!context) {
      if (this.contexts.size >= 128) throw new Error('p4p: достигнут лимит 128 контекстов WebSocket. Завершите ненужные сессии.');
      context = { sessionID: event.sessionID, fingerprint, selected, settings, mapping: {}, responses: new Set(), decoder: new ResponsesDecoder(), touched: this.now(), bytes: 0, queue: Promise.resolve(), inFlight: false, lanes: new Set() };
      this.contexts.set(key, context);
    }
    context.inFlight = true;
    context.settings = settings;
    context.selected = selected;
    context.touched = this.now();
  }
  async send(event: WebSocketFrame): Promise<Statistics | undefined> {
    this.ensureOpen();
    const context = this.contexts.get(keyOf(event));
    if (!context) return;
    const operation = context.queue.then(async () => {
      context.touched = this.now();
      const value = parseFrame(event.frame);
      if (value.type === 'response.cancel') { const lane = typeof value.stream_id === 'string' ? value.stream_id : ''; context.decoder.clear(lane); context.lanes.delete(lane); context.inFlight = context.lanes.size > 0; return; }
      if (value.type !== 'response.create') {
        if (context.selected) throw new Error('p4p: поддержан WebSocket протокол Responses API (response.create).');
        return;
      }
      if (context.selected && value.previous_response_id && !context.responses.has(value.previous_response_id)) throw new Error('p4p: таблица предыдущего ответа WebSocket недоступна. Начните новую сессию или отправьте полный контекст.');
      const lane = typeof value.stream_id === 'string' ? value.stream_id : '';
      context.decoder.clear(lane);
      context.lanes.add(lane);
      if (!context.selected) return;
      const result = await maskRequest(context.settings, value, context.mapping);
      const bytes = Buffer.byteLength(JSON.stringify(result.mapping));
      const total = [...this.contexts.values()].reduce((sum, entry) => sum + entry.bytes, 0) - context.bytes + bytes;
      if (Object.keys(result.mapping).length > 10000 || bytes > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('p4p: превышен лимит таблицы замен WebSocket. Начните новую сессию.');
      context.mapping = result.mapping;
      context.bytes = bytes;
      context.decoder.update(result.mapping);
      const encoded = JSON.stringify(result.value);
      if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error('p4p: замаскированное сообщение WebSocket превышает 16 МБ.');
      event.frame = encoded;
      return result.statistics;
    });
    context.queue = operation.then(() => {}, () => {});
    return operation;
  }
  receive(event: WebSocketFrame): void {
    this.ensureOpen();
    const context = this.contexts.get(keyOf(event));
    if (!context) return;
    context.touched = this.now();
    const value = parseFrame(event.frame);
    try {
      const restored = context.decoder.frame(value);
      if (['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled', 'error'].includes(value.type)) { context.lanes.delete(typeof value.stream_id === 'string' ? value.stream_id : ''); context.inFlight = context.lanes.size > 0; }
      if (typeof value.response?.id === 'string') {
        if (context.responses.size >= 10000 && !context.responses.has(value.response.id)) throw new Error('p4p: превышен лимит истории ответов WebSocket. Начните новую сессию.');
        context.responses.add(value.response.id);
      }
      const encoded = JSON.stringify(restored);
      if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Error('p4p: восстановленное сообщение WebSocket превышает 32 МБ.');
      event.frame = encoded;
    } catch (error) { context.decoder.clear(); throw error; }
  }
  interrupt(sessionID: string): void { for (const context of this.contexts.values()) if (context.sessionID === sessionID) { context.decoder.clear(); context.lanes.clear(); context.inFlight = false; } }
  remove(sessionID: string): void { for (const [key, context] of this.contexts) if (context.sessionID === sessionID) this.contexts.delete(key); }
  dispose(): void { this.closed = true; clearInterval(this.timer); this.contexts.clear(); }
}

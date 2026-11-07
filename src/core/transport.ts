import { createHash } from 'node:crypto';
import { SettingsStore } from './settings.js';
import { matchesHost } from './hosts.js';
import { maskRequest, restoreValue, restoreStream } from './engine.js';
import type { Settings, Statistics, TransformResult } from './types.js';
import type { RequestIdentity } from './failures.js';

interface ActiveRequest { mapping: Record<string, string> }
interface Context extends ActiveRequest {
  sessionID: string;
  queue: Promise<void>;
  pending: number;
  touched: number;
  bytes: number;
}
export class MaskingTransport {
  private closed = false;
  private active = new WeakMap<Request, ActiveRequest>();
  private contexts = new Map<string, Context>();
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly store: SettingsStore, private now = Date.now, readonly idleTTL = 60 * 60 * 1000) {
    this.timer = setInterval(() => this.expire(), Math.min(idleTTL, 60000));
    this.timer.unref();
  }
  private ensureOpen(): void { if (this.closed) throw new Error('p4p: обработчик HTTP остановлен. Перезапустите OpenCode.'); }
  private expire(): void { for (const [key, value] of this.contexts) if (!value.pending && this.now() - value.touched > this.idleTTL) this.contexts.delete(key); }
  private async mask(settings: Settings, payload: unknown, request: Request, identity?: RequestIdentity): Promise<TransformResult> {
    if (!identity) return maskRequest(settings, payload);
    this.expire();
    const fingerprint = createHash('sha256').update(JSON.stringify([request.url,
      ...['authorization', 'x-api-key', 'api-key', 'cookie'].map(name => request.headers.get(name))])).digest('hex');
    const key = JSON.stringify([identity.sessionID, identity.agent, identity.model.providerID, identity.model.id,
      identity.model.variant ?? '', identity.kind ?? 'primary', fingerprint]);
    let context = this.contexts.get(key);
    if (!context) {
      if (this.contexts.size >= 128) throw new Error('p4p: достигнут лимит 128 контекстов HTTP. Завершите ненужные сессии.');
      context = { sessionID: identity.sessionID, mapping: {}, queue: Promise.resolve(), pending: 0, touched: this.now(), bytes: 0 };
      this.contexts.set(key, context);
    }
    const current = context;
    current.pending++;
    const operation = current.queue.then(async () => {
      this.ensureOpen();
      const result = await maskRequest(settings, payload, current.mapping);
      this.ensureOpen();
      const bytes = Buffer.byteLength(JSON.stringify(result.mapping));
      const total = [...this.contexts.values()].reduce((sum, entry) => sum + entry.bytes, 0) - current.bytes + bytes;
      if (Object.keys(result.mapping).length > 10000 || bytes > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('p4p: превышен лимит таблицы замен HTTP. Начните новую сессию.');
      current.mapping = result.mapping;
      current.bytes = bytes;
      return result;
    }).finally(() => { current.pending--; current.touched = this.now(); });
    current.queue = operation.then(() => {}, () => {});
    return operation;
  }
  async request(request: Request, identity?: RequestIdentity): Promise<{ request: Request; statistics?: Statistics }> {
    this.ensureOpen();
    const { settings } = await this.store.read();
    if (!settings.enabled || !settings.patterns.length || !matchesHost(request.url, settings.hosts)) return { request };
    if (!request.body) return { request };
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('p4p: для выбранного хоста поддерживаются только JSON-запросы моделей.');
    const text = await limitedText(request.clone().body!, 16 * 1024 * 1024);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error('p4p: некорректный JSON запроса.'); }
    const result = await this.mask(settings, payload, request, identity);
    this.ensureOpen();
    if (!result.statistics.replacements) {
      if (Object.keys(result.mapping).length) this.active.set(request, { mapping: result.mapping });
      return { request, statistics: result.statistics };
    }
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const replaced = new Request(request, { body: JSON.stringify(result.value), headers });
    this.active.set(replaced, { mapping: result.mapping });
    return { request: replaced, statistics: result.statistics };
  }
  async response(request: Request, response: Response): Promise<Response> {
    const active = this.active.get(request);
    if (!active || !response.body) return response;
    this.active.delete(request);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json') && !type.includes('text/event-stream')) throw new Error('p4p: ответ модели должен быть JSON или SSE.');
    const headers = new Headers(response.headers);
    for (const key of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest']) headers.delete(key);
    const input = await decodedBody(response);
    let body: BodyInit;
    if (type.includes('text/event-stream')) body = restoreStream(input, active.mapping);
    else {
      const text = await limitedText(input, 32 * 1024 * 1024);
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error('p4p: некорректный JSON ответа.'); }
      body = JSON.stringify(await restoreValue(value, active.mapping));
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
  remove(sessionID: string): void { for (const [key, context] of this.contexts) if (context.sessionID === sessionID) this.contexts.delete(key); }
  dispose(): void { this.closed = true; clearInterval(this.timer); this.contexts.clear(); }
}
async function decodedBody(response: Response): Promise<ReadableStream<Uint8Array>> {
  const encoding = response.headers.get('content-encoding')?.toLowerCase();
  const input = response.body!;
  if (!encoding || encoding === 'identity') return input;
  if (encoding !== 'gzip') throw new Error('p4p: поддерживается сжатие gzip или несжатый ответ.');
  const reader = input.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < 2) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value); size += chunk.value.length;
  }
  const prefix = Buffer.concat(chunks);
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
      try { const chunk = await reader.read(); chunk.done ? controller.close() : controller.enqueue(chunk.value); }
      catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return prefix[0] === 0x1f && prefix[1] === 0x8b ? stream.pipeThrough(new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>) : stream;
}

async function limitedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) { void reader.cancel().catch(() => {}); throw new Error('p4p: превышен допустимый размер сообщения.'); }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

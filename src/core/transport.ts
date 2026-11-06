import { SettingsStore } from './settings.js';
import { matchesHost } from './hosts.js';
import { maskRequest, restoreValue, restoreStream } from './engine.js';
import type { Statistics } from './types.js';

interface ActiveRequest { mapping: Record<string, string> }
export class MaskingTransport {
  private active = new WeakMap<Request, ActiveRequest>();
  constructor(readonly store: SettingsStore) {}
  async request(request: Request): Promise<{ request: Request; statistics?: Statistics }> {
    const { settings } = await this.store.read();
    if (!settings.enabled || !settings.patterns.length || !matchesHost(request.url, settings.hosts)) return { request };
    if (!request.body) return { request };
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('Batya: для выбранного хоста поддерживаются только JSON-запросы моделей.');
    const text = await limitedText(request.clone().body!, 16 * 1024 * 1024);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error('Batya: некорректный JSON запроса.'); }
    const result = await maskRequest(settings, payload);
    if (!result.statistics.replacements) return { request, statistics: result.statistics };
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
    if (!type.includes('application/json') && !type.includes('text/event-stream')) throw new Error('Batya: ответ модели должен быть JSON или SSE.');
    const headers = new Headers(response.headers);
    for (const key of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest']) headers.delete(key);
    const input = await decodedBody(response);
    let body: BodyInit;
    if (type.includes('text/event-stream')) body = restoreStream(input, active.mapping);
    else {
      const text = await limitedText(input, 32 * 1024 * 1024);
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error('Batya: некорректный JSON ответа.'); }
      body = JSON.stringify(await restoreValue(value, active.mapping));
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
  async checkWebSocket(url: string): Promise<void> {
    const { settings } = await this.store.read();
    if (settings.enabled && settings.patterns.length && matchesHost(url, settings.hosts)) throw new Error('Batya: для маскирования выбранного хоста используйте HTTP/SSE вместо WebSocket.');
  }
}
async function decodedBody(response: Response): Promise<ReadableStream<Uint8Array>> {
  const encoding = response.headers.get('content-encoding')?.toLowerCase();
  const input = response.body!;
  if (!encoding || encoding === 'identity') return input;
  if (encoding !== 'gzip') throw new Error('Batya: поддерживается сжатие gzip или несжатый ответ.');
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
      if (size > limit) { void reader.cancel().catch(() => {}); throw new Error('Batya: превышен допустимый размер сообщения.'); }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

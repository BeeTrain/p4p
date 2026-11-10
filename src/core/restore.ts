import { parseTree, type Node, type ParseError } from 'jsonc-parser';

export const metadata = new Set(['id', 'model', 'role', 'type', 'object', 'tool_call_id', 'call_id', 'format', 'media_type', 'mime_type', 'response_id', 'previous_response_id', 'item_id', 'event_id', 'stream_id', 'file_id', 'container_id', 'encrypted_content', 'signature']);
const schemaMaps = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentRequired', 'dependentSchemas']);
const marker = /__P4P_[0-9a-f]{24}_[0-9]+__/g;
type Mapping = Record<string, string>;
interface Budget { remaining: number }
export function restoreText(text: string, mapping: Mapping, limit = 64 * 1024 * 1024): string {
  let size = Buffer.byteLength(text);
  if (size > limit) throw new Error('Результат восстановления слишком большой.');
  return text.replace(marker, key => {
    const replacement = mapping[key] ?? key;
    size += Buffer.byteLength(replacement) - key.length;
    if (size > limit) throw new Error('Результат восстановления слишком большой.');
    return replacement;
  });
}
export function restoreTree(value: any, mapping: Mapping, parent = '', budget: Budget = { remaining: 64 * 1024 * 1024 }): any {
  const text = (input: string) => {
    const result = restoreText(input, mapping, budget.remaining);
    budget.remaining -= Buffer.byteLength(result);
    return result;
  };
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map(item => restoreTree(item, mapping, parent, budget));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const restored = text(key);
    return [restored, !schemaMaps.has(parent) && metadata.has(key) ? item : restoreTree(item, mapping, restored, budget)];
  }));
  return value;
}
function splitTail(text: string): [string, string] {
  const start = text.lastIndexOf('__P4P_');
  if (start >= 0 && /^__P4P_[0-9a-f]{24}_[0-9]+__$/.test(text.slice(start))) return [text, ''];
  if (start >= 0 && text.length - start <= 100 && /^__P4P_[0-9a-f]*(?:_[0-9]*_?)?$/.test(text.slice(start))) return [text.slice(0, start), text.slice(start)];
  for (let size = 5; size > 0; size--) if (text.endsWith('__P4P_'.slice(0, size))) return [text.slice(0, -size), text.slice(-size)];
  return [text, ''];
}
interface Token { node: Node; original: string; value: string }
interface Frame { raw: string; data: string; tokens: Token[] }
interface Pending { token: Token; tail: string }
const field = (node: Node | undefined, key: string): Node | undefined => node?.type === 'object' ? node.children?.findLast(property => property.children?.[0].value === key)?.children?.[1] : undefined;

export class SSEDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private frames: Frame[] = [];
  private frameBytes = 0;
  private pending = new Map<string, Pending>();
  constructor(private mapping: Mapping, private limit = 16 * 1024 * 1024) {}
  private set(token: Token, value: string): void {
    this.frameBytes += Buffer.byteLength(JSON.stringify(value)) - Buffer.byteLength(JSON.stringify(token.value));
    if (this.frameBytes > this.limit) throw new Error('Превышен лимит буфера потока.');
    token.value = value;
  }
  private flush(): void {
    for (const { token, tail } of this.pending.values()) this.set(token, token.value + tail);
    this.pending.clear();
  }
  private strings(node: Node, path: unknown[], frame: Frame): void {
    if (node.type === 'array') {
      node.children?.forEach((item, index) => {
        const identity = field(item, 'index');
        const key = identity?.type === 'number' && !Number.isSafeInteger(identity.value)
          ? { number: frame.data.slice(identity.offset, identity.offset + identity.length) } : identity ? identity.value : index;
        this.strings(item, [...path, key], frame);
      });
    } else if (node.type === 'object') {
      for (const property of node.children ?? []) {
        const [key, item] = property.children!;
        const original = key.value as string;
        const restoredKey = restoreText(original, this.mapping, this.limit);
        const keyToken: Token = { node: key, original, value: original };
        frame.tokens.push(keyToken);
        if (restoredKey !== original) this.set(keyToken, restoredKey);
        if (!schemaMaps.has(String(path.at(-1))) && metadata.has(original)) continue;
        if (item.type === 'string') {
          const token: Token = { node: item, original: item.value, value: item.value };
          frame.tokens.push(token);
          const channel = JSON.stringify([...path, restoredKey]);
          const previous = this.pending.get(channel);
          this.pending.delete(channel);
          const [complete, tail] = splitTail((previous?.tail ?? '') + item.value);
          const restored = restoreText(complete, this.mapping, this.limit);
          const holder = previous?.token ?? token;
          if (previous) { this.set(token, ''); this.set(holder, holder.value + restored); }
          else if (restored !== token.value) this.set(token, restored);
          if (tail) this.pending.set(channel, { token: holder, tail });
        } else this.strings(item, [...path, restoredKey], frame);
      }
    }
  }
  private frame(raw: string): void {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ +/, '')).join('\n');
    const frame: Frame = { raw, data, tokens: [] };
    this.frames.push(frame);
    this.frameBytes += Buffer.byteLength(raw);
    const errors: ParseError[] = [];
    const node = parseTree(data, errors, { disallowComments: true, allowTrailingComma: false });
    if (!node || errors.length) {
      if (data === '[DONE]') this.flush();
    } else if (node.type === 'object') {
      const terminal = ['message_stop', 'response.completed', 'response.failed', 'response.incomplete'].includes(field(node, 'type')?.value);
      const finished = field(node, 'choices')?.children?.some(choice => !!field(choice, 'finish_reason')?.value);
      if (terminal || finished) this.flush();
      const channel = ['stream_id', 'response_id', 'index', 'output_index', 'content_index', 'item_id'].map(key => {
        const item = field(node, key);
        return item?.type === 'number' && !Number.isSafeInteger(item.value)
          ? { number: data.slice(item.offset, item.offset + item.length) } : item ? item.value : '';
      });
      this.strings(node, channel, frame);
    }
  }
  private drain(): string {
    const output = this.frames.map(frame => {
      const changes = frame.tokens.filter(token => token.value !== token.original).sort((a, b) => b.node.offset - a.node.offset);
      if (!changes.length) return frame.raw;
      let data = frame.data;
      for (const { node, value } of changes) data = data.slice(0, node.offset) + JSON.stringify(value) + data.slice(node.offset + node.length);
      const lines = frame.raw.split(/\r?\n/).filter(line => !line.startsWith('data:'));
      while (lines.length && !lines.at(-1)) lines.pop();
      return [...lines, 'data: ' + data, '', ''].join('\n');
    }).join('');
    this.frames = []; this.frameBytes = 0;
    return output;
  }
  *feedChunks(data: Uint8Array, final = false): Generator<Uint8Array> {
    this.buffer += this.decoder.decode(data, { stream: !final });
    if (Buffer.byteLength(this.buffer) + this.frameBytes > this.limit) throw new Error('Превышен лимит буфера потока.');
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) break;
      const end = boundary.index + boundary[0].length;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      this.frame(raw);
      if (!this.pending.size) yield new TextEncoder().encode(this.drain());
    }
    if (final) {
      const raw = this.buffer;
      this.buffer = '';
      if (raw) this.frame(raw);
      this.flush();
      const output = this.drain();
      if (output) yield new TextEncoder().encode(output);
    }
  }
  feed(data: Uint8Array, final = false): Uint8Array {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (const chunk of this.feedChunks(data, final)) {
      bytes += chunk.length;
      if (bytes > this.limit) throw new Error('Превышен лимит буфера потока.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  clear(): void {
    this.buffer = ''; this.frames = []; this.frameBytes = 0; this.pending.clear();
  }
}

export function restoreSSE(input: ReadableStream<Uint8Array>, mapping: Mapping): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const decoder = new SSEDecoder(mapping);
  let cancelled = false, released = false;
  let chunks: Generator<Uint8Array> | undefined;
  let ended = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (chunks) {
            const output = chunks.next();
            if (!output.done) { controller.enqueue(output.value); return; }
            chunks = undefined;
          }
          if (ended) { decoder.clear(); release(); controller.close(); return; }
          const chunk = await reader.read();
          if (cancelled) return;
          ended = chunk.done;
          chunks = decoder.feedChunks(chunk.value ?? new Uint8Array(), ended);
        }
      } catch (error) {
        if (cancelled) return;
        controller.error(error);
        chunks?.return(undefined); chunks = undefined; decoder.clear();
        await reader.cancel(error).catch(() => {});
        release();
      }
    },
    async cancel(reason) {
      cancelled = true;
      chunks?.return(undefined); chunks = undefined; decoder.clear();
      try { await reader.cancel(reason); } finally { release(); }
    }
  });
}

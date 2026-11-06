const metadata = new Set(['id', 'model', 'role', 'type', 'object', 'tool_call_id', 'call_id', 'format', 'media_type', 'mime_type', 'response_id', 'previous_response_id', 'item_id', 'event_id', 'stream_id', 'file_id', 'container_id', 'encrypted_content', 'signature']);
const marker = /__P4P_[0-9a-f]{24}_[0-9]+__/g;
const families = new Set(['response.output_text', 'response.refusal', 'response.reasoning_text', 'response.reasoning_summary_text', 'response.reasoning', 'response.function_call_arguments', 'response.custom_tool_call_input']);
const terminal = new Set(['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled', 'error']);
type Json = Record<string, any>;
interface Trie { children: Map<string, Trie>; value?: string }
interface Pending { lane: string; item: string; tail: string }

export class ResponsesDecoder {
  private root: Trie = { children: new Map() };
  private mapping: Record<string, string> = {};
  private pending = new Map<string, Pending>();
  private responses = new Map<string, string>();
  update(mapping: Record<string, string>): void {
    this.mapping = mapping;
    this.root = { children: new Map() };
    for (const [key, value] of Object.entries(mapping)) {
      let node = this.root;
      for (const char of key) {
        let child = node.children.get(char);
        if (!child) { child = { children: new Map() }; node.children.set(char, child); }
        node = child;
      }
      node.value = value;
    }
  }
  clear(lane?: string): void {
    if (lane === undefined) { this.pending.clear(); this.responses.clear(); return; }
    for (const [key, value] of this.pending) if (value.lane === lane) this.pending.delete(key);
    this.responses.delete(lane);
  }
  private restore(text: string): string { return text.replace(marker, value => this.mapping[value] ?? value); }
  private tree(value: any): any {
    if (typeof value === 'string') return this.restore(value);
    if (Array.isArray(value)) return value.map(item => this.tree(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.restore(key), metadata.has(key) ? item : this.tree(item)]));
    return value;
  }
  private chunk(text: string): { text: string; tail: string } {
    let output = '', index = 0;
    while (index < text.length) {
      let node = this.root, end = index;
      while (end < text.length && node.children.has(text[end])) node = node.children.get(text[end++])!;
      if (node.value !== undefined) { output += node.value; index = end; }
      else if (end === text.length && end > index && node.children.size) return { text: output, tail: text.slice(index) };
      else output += text[index++];
    }
    return { text: output, tail: '' };
  }
  frame(raw: Json): Json {
    const lane = typeof raw.stream_id === 'string' ? raw.stream_id : '';
    if (raw.type === 'response.created') {
      this.clear(lane);
      if (typeof raw.response?.id === 'string') this.responses.set(lane, raw.response.id);
    }
    const restored = this.tree(raw);
    const type = String(raw.type);
    const family = type.replace(/\.(delta|done)$/, '');
    const item = String(raw.item_id ?? raw.output_index ?? '');
    const channel = JSON.stringify([lane, raw.response_id ?? this.responses.get(lane) ?? '', item, raw.content_index ?? '', raw.summary_index ?? '', family]);
    if (families.has(family) && type.endsWith('.delta') && typeof raw.delta === 'string') {
      const previous = this.pending.get(channel)?.tail || '';
      const value = this.chunk(previous + raw.delta);
      restored.delta = value.text;
      if (value.tail) this.pending.set(channel, { lane, item, tail: value.tail });
      else this.pending.delete(channel);
    }
    if (families.has(family) && type.endsWith('.done')) {
      const pending = this.pending.get(channel);
      const final = raw.text ?? raw.refusal ?? raw.arguments ?? raw.input;
      if (pending && typeof final !== 'string') throw new Error('p4p: незавершённое обозначение без итогового текста WebSocket.');
      this.pending.delete(channel);
    }
    if (type === 'response.output_item.done') {
      for (const [key, value] of this.pending) if (value.lane === lane && (value.item === raw.item?.id || value.item === String(raw.output_index))) this.pending.delete(key);
    }
    if (terminal.has(type)) {
      if ((type === 'response.completed' || type === 'response.incomplete') && [...this.pending.values()].some(value => value.lane === lane)) throw new Error('p4p: поток завершился без итогового события для незавершённого обозначения.');
      this.clear(lane);
    }
    if (this.pending.size > 1024) throw new Error('p4p: слишком много незавершённых фрагментов WebSocket.');
    return restored;
  }
}

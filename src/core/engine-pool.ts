import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../python/engine.py', import.meta.url));
const limit = 64 * 1024 * 1024;
const children = new Set<ChildProcessWithoutNullStreams>();
export const python = () => process.env.P4P_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
process.once('exit', () => { for (const child of children) child.kill(); });

interface Job {
  id: number;
  data: string;
  bytes: number;
  timeout: number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface Slot {
  child?: ChildProcessWithoutNullStreams;
  active?: Job;
  queue: Job[];
  chunks: Buffer[];
  bytes: number;
  idle?: ReturnType<typeof setTimeout>;
}
function references(child: ChildProcessWithoutNullStreams, active: boolean): void {
  if (active) child.ref(); else child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    const handle = stream as typeof stream & { ref?: () => void; unref?: () => void };
    if (active) handle.ref?.(); else handle.unref?.();
  }
}

export class EnginePool {
  private slots: Slot[];
  private closed = false;
  private sequence = 0;
  private queuedBytes = 0;
  private queued = 0;
  private starts = 0;
  constructor(size = 2, private idleMs = 30000) {
    if (!Number.isInteger(size) || size < 1 || size > 8) throw new Error('Неверный размер пула Python.');
    this.slots = Array.from({ length: size }, () => ({ queue: [], chunks: [], bytes: 0 }));
  }
  get statistics(): { starts: number; queued: number; queuedBytes: number } {
    return { starts: this.starts, queued: this.queued, queuedBytes: this.queuedBytes };
  }
  run(mode: string, input: unknown, timeout = 5000, scope?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error('p4p: движок маскирования остановлен.'));
    const id = ++this.sequence;
    let data: string;
    try { data = JSON.stringify({ id, mode, input, scope }) + '\n'; }
    catch { return Promise.reject(new Error('Не удалось сериализовать запрос движка.')); }
    const bytes = Buffer.byteLength(data);
    if (bytes > limit) return Promise.reject(new Error('Превышен лимит сообщения движка.'));
    const index = scope === undefined
      ? this.slots.reduce((best, slot, i, slots) => slot.queue.length + Number(!!slot.active) < slots[best].queue.length + Number(!!slots[best].active) ? i : best, 0)
      : createHash('sha256').update(scope).digest().readUInt32LE(0) % this.slots.length;
    const slot = this.slots[index];
    if (this.queued >= 128 || (slot.active && this.queuedBytes + bytes > 32 * 1024 * 1024)) return Promise.reject(new Error('p4p: очередь маскирования переполнена.'));
    return new Promise((resolve, reject) => {
      const job: Job = { id, data, bytes, timeout, resolve, reject };
      job.timer = setTimeout(() => {
        const position = slot.queue.indexOf(job);
        if (position < 0) return;
        slot.queue.splice(position, 1);
        this.queued--; this.queuedBytes -= bytes;
        reject(new Error('Превышено время ожидания очереди маскирования.'));
      }, 30000);
      slot.queue.push(job); this.queued++; this.queuedBytes += bytes;
      this.dispatch(slot);
    });
  }
  forget(scope: string): void { if (!this.closed) void this.run('forget', {}, 5000, scope).catch(() => {}); }
  private start(slot: Slot): void {
    const child = spawn(python(), ['-B', script, 'worker'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.starts++;
    slot.child = child;
    children.add(child);
    child.stderr.resume();
    child.stdin.on('error', () => { if (slot.child === child) this.fail(slot, new Error('Поток запроса движка прерван.')); });
    child.on('error', () => { if (slot.child === child) this.fail(slot, new Error('Не удалось запустить Python 3. Установите его или задайте P4P_PYTHON.')); });
    child.on('close', () => {
      children.delete(child);
      if (slot.child === child) this.fail(slot, new Error('Движок маскирования завершился без корректного результата.'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (slot.child !== child) return;
      slot.bytes += chunk.length;
      if (slot.bytes > limit) { this.fail(slot, new Error('Результат маскирования слишком большой.')); return; }
      slot.chunks.push(chunk);
      if (!chunk.includes(10)) return;
      const output = Buffer.concat(slot.chunks);
      slot.chunks = []; slot.bytes = 0;
      const job = slot.active;
      try {
        if (!job) throw new Error();
        const result = JSON.parse(output.toString('utf8'));
        if (result.id !== job.id || (!Object.hasOwn(result, 'value') && typeof result.error !== 'string')) throw new Error();
        clearTimeout(job.timer);
        slot.active = undefined;
        if (typeof result.error === 'string') job.reject(new Error(result.error)); else job.resolve(result.value);
        this.dispatch(slot);
      } catch { this.fail(slot, new Error('Движок маскирования вернул некорректный результат.')); }
    });
  }
  private dispatch(slot: Slot): void {
    if (this.closed || slot.active) return;
    clearTimeout(slot.idle);
    const job = slot.queue.shift();
    if (!job) {
      if (slot.child) {
        references(slot.child, false);
        slot.idle = setTimeout(() => this.stop(slot), this.idleMs);
        slot.idle.unref();
      }
      return;
    }
    this.queued--; this.queuedBytes -= job.bytes;
    clearTimeout(job.timer);
    slot.active = job;
    job.timer = setTimeout(() => this.fail(slot, new Error('Превышен лимит обработки правил (5 секунд). Упростите regex.')), job.timeout);
    try {
      if (!slot.child) this.start(slot);
      references(slot.child!, true);
      slot.child!.stdin.write(job.data);
    } catch { this.fail(slot, new Error('Не удалось запустить Python 3. Установите его или задайте P4P_PYTHON.')); }
  }
  private stop(slot: Slot): void {
    clearTimeout(slot.idle);
    const child = slot.child;
    slot.child = undefined;
    slot.chunks = []; slot.bytes = 0;
    if (child) { children.delete(child); child.kill('SIGKILL'); }
  }
  private fail(slot: Slot, error: Error): void {
    const job = slot.active;
    slot.active = undefined;
    clearTimeout(job?.timer);
    this.stop(slot);
    job?.reject(error);
    this.dispatch(slot);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots) {
      const error = new Error('p4p: движок маскирования остановлен.');
      for (const job of slot.queue.splice(0)) { clearTimeout(job.timer); job.reject(error); }
      this.fail(slot, error);
    }
    this.queued = 0; this.queuedBytes = 0;
  }
}

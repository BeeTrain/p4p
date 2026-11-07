import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { Settings, TransformResult } from './types.js';

const script = fileURLToPath(new URL('../../python/engine.py', import.meta.url));
export const python = () => process.env.P4P_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const engineSettings = (settings: Settings) => ({ enabled: settings.enabled, words: [], patterns: settings.patterns, diagnostics: settings.diagnostics });

export async function runEngine(mode: string, input: unknown, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), [script, mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const output: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Превышен лимит обработки правил (5 секунд). Упростите regex.')); }, timeout);
    child.on('error', () => finish(new Error('Не удалось запустить Python 3. Установите его или задайте P4P_PYTHON.')));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { child.kill(); finish(new Error('Результат маскирования слишком большой.')); }
      else output.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', code => {
      try {
        const result = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (code) finish(new Error(typeof result.error === 'string' ? result.error : 'Ошибка движка маскирования.'));
        else finish(undefined, result);
      } catch { finish(new Error('Движок маскирования завершился без корректного результата.')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
export async function validatePatterns(settings: Settings): Promise<void> {
  await runEngine('validate', { settings: engineSettings(settings) });
}
export async function maskRequest(settings: Settings, value: unknown, mapping: Record<string, string> = {}): Promise<TransformResult> {
  return runEngine('request', { settings: engineSettings(settings), value, mapping });
}
export async function preview(settings: Settings, text: string): Promise<TransformResult> {
  if (text.length > 256000) throw new Error('Предпросмотр ограничен 256 000 символами.');
  return runEngine('preview', { settings: engineSettings(settings), value: text });
}
export async function restoreValue(value: unknown, mapping: Record<string, string>): Promise<unknown> {
  return runEngine('restore', { value, mapping });
}
export function restoreStream(input: ReadableStream<Uint8Array>, mapping: Record<string, string>): ReadableStream<Uint8Array> {
  const child = spawn(python(), [script, 'stream'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.write(JSON.stringify(mapping) + '\n');
  child.stderr.resume();
  let failed: Error | undefined;
  child.on('error', () => { failed = new Error('Не удалось запустить восстановление ответа.'); child.stdout.destroy(failed); });
  const exit = new Promise<void>((resolve, reject) => {
    child.on('close', code => code === 0 ? resolve() : reject(failed || new Error('Поток восстановления завершился с ошибкой.')));
    child.on('error', reject);
  });
  exit.catch(() => {});
  const reader = input.getReader();
  const pump = async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!child.stdin.write(chunk.value)) await once(child.stdin, 'drain');
      }
      child.stdin.end();
    } catch (error) { failed = error instanceof Error ? error : new Error('Поток прерван.'); child.stdout.destroy(failed); child.kill(); }
    finally { reader.releaseLock(); }
  };
  void pump();
  child.stdin.on('error', error => { failed = error; });
  const output = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await output.read();
        if (chunk.done) { await exit; controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); void reader.cancel().catch(() => {}); child.kill(); }
    },
    async cancel(reason) { await output.cancel(reason).catch(() => {}); await reader.cancel(reason).catch(() => {}); child.kill(); }
  });
}

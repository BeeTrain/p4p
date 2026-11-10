import type { Settings, TransformResult } from './types.js';
import { EnginePool } from './engine-pool.js';
import { restoreTree, restoreSSE } from './restore.js';
export { EnginePool, python } from './engine-pool.js';

const engineSettings = (settings: Settings) => ({ enabled: settings.enabled, words: [], patterns: settings.patterns, diagnostics: settings.diagnostics });
const pool = new EnginePool();

export async function runEngine(mode: string, input: unknown, timeout = 5000): Promise<any> {
  return pool.run(mode, input, timeout);
}
export async function validatePatterns(settings: Settings): Promise<void> {
  await runEngine('validate', { settings: engineSettings(settings) });
}
export async function maskRequest(settings: Settings, value: unknown, mapping: Record<string, string> = {}, engine = pool, scope?: string): Promise<TransformResult> {
  return engine.run('request', { settings: engineSettings(settings), value, mapping }, 5000, scope);
}
export async function preview(settings: Settings, text: string): Promise<TransformResult> {
  if (text.length > 256000) throw new Error('Предпросмотр ограничен 256 000 символами.');
  return runEngine('preview', { settings: engineSettings(settings), value: text });
}
export async function restoreValue(value: unknown, mapping: Record<string, string>): Promise<unknown> {
  return restoreTree(value, mapping);
}
export function restoreStream(input: ReadableStream<Uint8Array>, mapping: Record<string, string>): ReadableStream<Uint8Array> {
  return restoreSSE(input, mapping);
}

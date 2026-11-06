import { normalizeSettings } from './settings.js';
import { validatePatterns } from './engine.js';
import type { Settings } from './types.js';

export const CONFIG_LIMIT_BYTES = 8 * 1024 * 1024;
export interface ConfigDocument { name: string; content: string }
export async function parseConfig(content: string): Promise<Settings> {
  if (new TextEncoder().encode(content).byteLength > CONFIG_LIMIT_BYTES) throw new Error('Файл конфигурации превышает 8 МБ.');
  let value: unknown;
  try { value = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Файл должен содержать корректный JSON конфигурации p4p.'); }
  if (value && typeof value === 'object' && !Array.isArray(value) && !('enabled' in value) && 'settings' in value) value = value.settings;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'words' in value && !('patterns' in value)) value = { ...value, patterns: [] };
  const settings = normalizeSettings(value);
  await validatePatterns(settings);
  return settings;
}
export async function serializeConfig(value: unknown): Promise<ConfigDocument> {
  const settings = normalizeSettings(value);
  await validatePatterns(settings);
  const content = JSON.stringify(settings, null, 2) + '\n';
  if (new TextEncoder().encode(content).byteLength > CONFIG_LIMIT_BYTES) throw new Error('Конфигурация превышает 8 МБ.');
  return { name: 'p4p-config.json', content };
}

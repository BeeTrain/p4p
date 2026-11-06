import { mkdir, readFile, writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import defaults from './defaults.json' with { type: 'json' };
import { normalizeHost } from './hosts.js';
import { validatePatterns } from './engine.js';
import type { Settings, SettingsView } from './types.js';

export function configPath(given?: string): string {
  const value = given || process.env.BATYA_CONFIG;
  return value ? resolve(value.startsWith('~/') ? join(homedir(), value.slice(2)) : value) : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'batya', 'config.json');
}
export const defaultSettings = (): Settings => structuredClone(defaults) as Settings;
export function normalizeSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Настройки должны быть объектом JSON.');
  const input = value as Record<string, unknown>;
  if (input.version !== undefined && input.version !== 1) throw new Error('Неподдерживаемая версия настроек.');
  if (typeof input.enabled !== 'boolean') throw new Error('Укажите, включено ли маскирование.');
  const words = input.words ?? [];
  if (!Array.isArray(words) || words.some(word => typeof word !== 'string' || !word.trim())) throw new Error('Неверный прежний словарь слов.');
  const literal = (word: string) => '(?i)' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [...words.map(literal), ...(Array.isArray(input.patterns) ? input.patterns : [])];
  if (!Array.isArray(input.patterns) || patterns.length > 600 || patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern.length > 2000 || /[\r\n]/.test(pattern))) throw new Error('Укажите до 600 непустых паттернов, по одному на строку (до 2000 символов).');
  const hosts = input.hosts ?? [];
  if (!Array.isArray(hosts) || hosts.length > 200 || hosts.some(host => typeof host !== 'string')) throw new Error('Укажите до 200 хостов.');
  if (input.diagnostics !== undefined && (!input.diagnostics || typeof input.diagnostics !== 'object' || Array.isArray(input.diagnostics))) throw new Error('Неверные переключатели диагностики.');
  const diagnostics = { ...defaults.diagnostics, ...(input.diagnostics as object ?? {}) };
  if (Object.values(diagnostics).some(value => typeof value !== 'boolean') || Object.keys(diagnostics).some(key => !(key in defaults.diagnostics))) throw new Error('Неверные переключатели диагностики.');
  return { version: 1, enabled: input.enabled, hosts: [...new Set(hosts.map(normalizeHost))], patterns: [...new Set(patterns.map(pattern => pattern.trim()))], diagnostics };
}
const revision = (settings: Settings) => createHash('sha256').update(JSON.stringify(settings)).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class SettingsStore {
  readonly path: string;
  constructor(path?: string) { this.path = configPath(path); }
  async read(): Promise<SettingsView> {
    let settings: Settings;
    try { settings = normalizeSettings(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (isMissing(error)) settings = defaultSettings(); else throw error; }
    return { settings, revision: revision(settings), path: this.path };
  }
  private async lock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = this.path + '.lock';
    const deadline = Date.now() + 3000;
    let handle;
    while (!handle) {
      try { handle = await open(lockPath, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const lock = JSON.parse(await readFile(lockPath, 'utf8'));
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          let alive = true;
          try { process.kill(lock.pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
          if (!alive && age > 30000) { await unlink(lockPath); continue; }
        } catch {}
        if (Date.now() > deadline) throw new Error('Настройки заняты другим процессом. Повторите сохранение.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await action(); }
    finally { await handle.close(); await unlink(lockPath).catch(() => {}); }
  }
  async update(change: (settings: Settings) => Settings | Promise<Settings>, expectedRevision?: string): Promise<SettingsView> {
    return this.lock(async () => {
      const previous = await this.read();
      if (expectedRevision && previous.revision !== expectedRevision) throw new Error('Настройки изменились в другом окне или терминале. Перезагрузите их перед сохранением.');
      const settings = normalizeSettings(await change(structuredClone(previous.settings)));
      await validatePatterns(settings);
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path); }
      finally { await unlink(temporary).catch(() => {}); }
      return { settings, revision: revision(settings), path: this.path };
    });
  }
  async save(value: unknown, expectedRevision?: string): Promise<SettingsView> { return this.update(() => normalizeSettings(value), expectedRevision); }
}

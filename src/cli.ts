#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { SettingsStore, normalizeSettings, preview, normalizeHost, matchesHost } from './core/index.js';
import type { Diagnostics, Settings } from './core/types.js';

const args = process.argv.slice(2);
function flag(name: string): boolean { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; }
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`После ${name} нужно значение.`);
  return args.splice(index, 2)[1];
}
async function stdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Передайте текст через --text, --file или стандартный ввод.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; if (length > 1024000) throw new Error('Ввод слишком большой.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function requireArguments(): void { if (!args.length) throw new Error('Не указано значение. См. batya help.'); }
const help = `batya — маскирование для OpenCode 2.2.5

batya init                              Создать пустые настройки
batya status                            Статус и путь настроек
batya list                              Посмотреть словарь
batya add 'secret' '(?i)private'          Добавить паттерны
batya add --literal --ignore-case 'a.b'  Добавить буквальный текст
batya remove 1                          Удалить по номеру (с 1) или точному паттерну
batya hosts list|add|remove [хосты]       Настроить хосты моделей
batya enable|disable                    Включить или выключить
batya diagnostics set logs on           Обработка найденных логов
batya diagnostics set stacktraces on    Обработка стектрейсов
batya diagnostics set marked on         Поиск по ограждениям и тегам
batya diagnostics set heuristics on     Поиск по структуре строк
batya diagnostics set tool_output off   Считать весь вывод инструментов логом
batya preview --text 'secret'           Предпросмотр и восстановление
batya preview --file ./example.txt      Предпросмотр файла (или pipe)
batya config show|path                  Посмотреть настройки или их путь
batya install --opencode-config FILE    Подключить собранный плагин в FILE

--config FILE   Отдельный файл настроек batya (или BATYA_CONFIG)
--json          Результат в JSON
--host URL      Проверить область действия в preview
Словарь единый: одна строка — один Python regex. Слова тоже являются regex.
Хосты: точный хост, host:port или *.example.com. По умолчанию список пуст.
Транспорт: HTTP/SSE и WebSocket Responses API.
`;
async function main(): Promise<void> {
  const config = option('--config'); const json = flag('--json');
  const store = new SettingsStore(config);
  const command = args.shift() || 'help';
  const print = (value: unknown) => process.stdout.write(typeof value === 'string' && !json ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
  if (command === 'help' || command === '--help' || command === '-h') { process.stdout.write(help); return; }
  if (command === 'init') { print(await store.update(value => value)); return; }
  if (command === 'status') { const view = await store.read(); print(json ? view : `Batya: ${view.settings.enabled ? 'включён' : 'выключен'}\nПаттернов: ${view.settings.patterns.length}\nХостов: ${view.settings.hosts.length}\nНастройки: ${view.path}`); return; }
  if (command === 'config') { const mode = args.shift() || 'show'; const view = await store.read(); if (!['show', 'path'].includes(mode)) throw new Error('Используйте config show|path.'); print(mode === 'path' ? view.path : view); return; }
  if (command === 'enable' || command === 'disable') { print(await store.update(value => ({ ...value, enabled: command === 'enable' }))); return; }
  if (command === 'list' || command === 'add' || command === 'remove' || command === 'patterns') {
    const action = command === 'patterns' ? args.shift() || 'list' : command;
    if (action === 'list') { const { settings } = await store.read(); print(json ? settings.patterns : settings.patterns.map((p, i) => `${i + 1}. ${p}`).join('\n') || 'Словарь пуст.'); return; }
    if (action === 'add') {
      const literal = flag('--literal'), insensitive = flag('--ignore-case'); requireArguments();
      const patterns = args.map(value => (insensitive ? '(?i)' : '') + (literal ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : value));
      print(await store.update(value => ({ ...value, patterns: [...value.patterns, ...patterns] }))); return;
    }
    if (action === 'remove') {
      requireArguments();
      print(await store.update(value => {
        const selected = new Set(args.map(item => /^\d+$/.test(item) ? value.patterns[+item - 1] : item));
        if ([...selected].some(item => item === undefined || !value.patterns.includes(item))) throw new Error('Паттерн или номер не найден.');
        return { ...value, patterns: value.patterns.filter(item => !selected.has(item)) };
      })); return;
    }
    throw new Error('Используйте patterns list|add|remove.');
  }
  if (command === 'hosts') {
    const action = args.shift() || 'list';
    if (action === 'list') { const { settings } = await store.read(); print(json ? settings.hosts : settings.hosts.join('\n') || 'Хосты не выбраны.'); return; }
    requireArguments(); const hosts = args.map(normalizeHost);
    if (!['add', 'remove'].includes(action)) throw new Error('Используйте hosts list|add|remove.');
    print(await store.update(value => ({ ...value, hosts: action === 'add' ? [...value.hosts, ...hosts] : value.hosts.filter(host => !hosts.includes(host)) }))); return;
  }
  if (command === 'diagnostics') {
    const action = args.shift() || 'show';
    if (action === 'show') { print((await store.read()).settings.diagnostics); return; }
    const key = args.shift() as keyof Diagnostics, value = args.shift();
    if (action !== 'set' || !['on', 'off'].includes(value || '') || !(key in (await store.read()).settings.diagnostics)) throw new Error('Используйте diagnostics set <logs|stacktraces|marked|heuristics|tool_output> on|off.');
    print(await store.update(settings => ({ ...settings, diagnostics: { ...settings.diagnostics, [key]: value === 'on' } }))); return;
  }
  if (command === 'preview') {
    const inline = option('--text'), file = option('--file'), host = option('--host');
    if (inline !== undefined && file) throw new Error('Выберите --text или --file.');
    const text = inline ?? (file ? await readFile(resolve(file), 'utf8') : await stdin());
    const { settings } = await store.read(); const { mapping, ...result } = await preview(settings, text);
    print({ ...result, hostMatches: host ? matchesHost(host.includes('://') ? host : `https://${host}`, settings.hosts) : null }); return;
  }
  if (command === 'install') {
    const destination = option('--opencode-config');
    if (!destination) throw new Error('Укажите --opencode-config FILE. Команда изменит только этот файл.');
    const target = resolve(destination); const root = fileURLToPath(new URL('../', import.meta.url));
    let text = '{}\n';
    try { text = await readFile(target, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const errors: import('jsonc-parser').ParseError[] = [];
    const current = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
    if (errors.length || !current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Неверный JSON/JSONC конфигурации OpenCode.');
    const plugins = current.plugins ?? [];
    if (!Array.isArray(plugins)) throw new Error('Поле plugins должно быть массивом.');
    const entry = { package: root, options: { config: store.path } };
    const filtered = plugins.filter(item => !(item === root || typeof item === 'object' && item?.package === root));
    const updated = applyEdits(text, modify(text, ['plugins'], [...filtered, entry], { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, updated, { mode: 0o600 });
    print({ opencode: target, plugin: root, config: store.path, next: 'Перезапустите OpenCode. Настройки Batya находятся в Settings → Batya и команде Batya.' }); return;
  }
  throw new Error(`Неизвестная команда: ${command}. См. batya help.`);
}
main().catch(error => { process.stderr.write(`Batya: ${error instanceof Error ? error.message : 'Ошибка.'}\n`); process.exitCode = 1; });

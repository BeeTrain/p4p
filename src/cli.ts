#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { SettingsStore, normalizeSettings, preview, normalizeHost, matchesHost, parseConfig, serializeConfig, writeConfigExport, CONFIG_LIMIT_BYTES, FailureStore } from './core/index.js';
import type { Diagnostics, Settings } from './core/types.js';

const args = process.argv.slice(2);
function flag(name: string): boolean { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; }
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`После ${name} нужно значение.`);
  return args.splice(index, 2)[1];
}
async function stdin(limit = 1024000): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Передайте текст через --text, --file или стандартный ввод.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; if (length > limit) throw new Error('Ввод слишком большой.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function requireArguments(): void { if (!args.length) throw new Error('Не указано значение. См. p4p help.'); }
const help = `p4p — маскирование для OpenCode 2.2.5

p4p init                              Создать пустые настройки
p4p status                            Статус и путь настроек
p4p list                              Посмотреть словарь
p4p add 'secret' '(?i)private'          Добавить паттерны
p4p add --literal --ignore-case 'a.b'  Добавить буквальный текст
p4p remove 1                          Удалить по номеру (с 1) или точному паттерну
p4p hosts list|add|remove [хосты]       Настроить хосты моделей
p4p enable|disable                    Включить или выключить
p4p diagnostics set logs on           Обработка найденных логов
p4p diagnostics set stacktraces on    Обработка стектрейсов
p4p diagnostics set marked on         Поиск по ограждениям и тегам
p4p diagnostics set heuristics on     Поиск по структуре строк
p4p diagnostics set tool_output off   Считать весь вывод инструментов логом
p4p preview --text 'secret'           Предпросмотр и восстановление
p4p preview --file ./example.txt      Предпросмотр файла (или pipe)
p4p import FILE|-                    Импортировать всю конфигурацию
p4p export [FILE|-]                  Экспортировать конфигурацию в JSON
p4p requests list                    Неуспешные запросы
p4p requests export ID|latest [FILE]  Выгрузить запрос в JSON
p4p requests clear                   Очистить журнал ошибок
p4p config show|path                  Посмотреть настройки или их путь
p4p install --opencode-config FILE    Подключить собранный плагин в FILE

--config FILE   Отдельный файл настроек p4p (или P4P_CONFIG)
--json          Результат в JSON
--force         Заменить существующий файл экспорта
--host URL      Проверить область действия в preview
Словарь единый: одна строка — один Python regex. Слова тоже являются regex.
Хосты: точный хост, host:port или *.example.com. По умолчанию список пуст.
Транспорт: HTTP/SSE и WebSocket Responses API.
`;
async function main(): Promise<void> {
  const config = option('--config'); const json = flag('--json');
  const store = new SettingsStore(config);
  let command = args.shift() || 'help';
  if (command === 'config' && ['import', 'export'].includes(args[0])) command = args.shift()!;
  const print = (value: unknown) => process.stdout.write(typeof value === 'string' && !json ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
  if (command === 'help' || command === '--help' || command === '-h') { process.stdout.write(help); return; }
  if (command === 'init') { print(await store.update(value => value)); return; }
  if (command === 'status') { const view = await store.read(); print(json ? view : `p4p: ${view.settings.enabled ? 'включён' : 'выключен'}\nПаттернов: ${view.settings.patterns.length}\nХостов: ${view.settings.hosts.length}\nНастройки: ${view.path}`); return; }
  if (command === 'requests') {
    const failures = new FailureStore(store.path), action = args.shift() || 'list';
    if (action === 'list') {
      const value = await failures.listing();
      print(json ? value : value.rows.map(row => `${row.id}  ${row.http_status || row.source}  ${row.model}  ${new Date(row.started_at * 1000).toISOString()}`).join('\n') || 'Неуспешных запросов пока нет.'); return;
    }
    if (action === 'clear') { await failures.clear(); print(json ? { cleared: true } : 'Журнал ошибок очищен.'); return; }
    if (action === 'export') {
      const overwrite = flag('--force'), given = args.shift();
      if (!given) throw new Error('Укажите ID запроса или latest.');
      const id = given === 'latest' ? (await failures.listing()).rows[0]?.id : given;
      if (!id) throw new Error('Неуспешных запросов пока нет.');
      const file = option('--file') ?? args.shift() ?? '-';
      if (args.length || file.startsWith('--')) throw new Error('Используйте p4p requests export ID|latest [FILE|-].');
      const document = await failures.export(id);
      if (file === '-') process.stdout.write(document.content);
      else { const path = resolve(file); if (await realpath(path).catch(() => path) === await realpath(store.path).catch(() => store.path)) throw new Error('Выберите отдельный файл экспорта, а не рабочий файл настроек.'); await writeConfigExport(path, document.content, overwrite); print(json ? { file: path } : `Запрос экспортирован: ${path}`); }
      return;
    }
    throw new Error('Используйте requests list|export|clear.');
  }
  if (command === 'import' || command === 'export') {
    const overwrite = command === 'export' && flag('--force');
    const file = option('--file') ?? args.shift() ?? (command === 'export' ? '-' : undefined);
    if (!file || args.length || file.startsWith('--')) throw new Error(`Используйте p4p ${command} FILE|- (или --file FILE).`);
    if (command === 'import') {
      let content: string;
      if (file === '-') content = await stdin(CONFIG_LIMIT_BYTES);
      else { const path = resolve(file); if ((await stat(path)).size > CONFIG_LIMIT_BYTES) throw new Error('Файл конфигурации превышает 8 МБ.'); content = await readFile(path, 'utf8'); }
      print(await store.save(await parseConfig(content)));
    } else {
      const document = await serializeConfig((await store.read()).settings);
      if (file === '-') process.stdout.write(document.content);
      else {
        const path = resolve(file);
        const sourcePath = await realpath(store.path).catch(() => store.path);
        const outputPath = await realpath(path).catch(() => path);
        if (outputPath === sourcePath) throw new Error('Выберите отдельный файл экспорта, а не рабочий файл настроек.');
        await writeConfigExport(path, document.content, overwrite);
        print(json ? { file: path } : `Конфигурация экспортирована: ${path}`);
      }
    }
    return;
  }
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
    const target = resolve(destination); const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
    let text = '{}\n';
    try { text = await readFile(target, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const errors: import('jsonc-parser').ParseError[] = [];
    const current = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
    if (errors.length || !current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Неверный JSON/JSONC конфигурации OpenCode.');
    const plugins = current.plugins ?? [];
    if (!Array.isArray(plugins)) throw new Error('Поле plugins должно быть массивом.');
    const related = async (item: unknown): Promise<boolean> => {
      const spec = typeof item === 'string' ? item : item && typeof item === 'object' && 'package' in item ? item.package : undefined;
      if (typeof spec !== 'string') return false;
      if (/^p4p(?:@|$)/.test(spec)) return true;
      if (/^(?:(?:git\+)?https:\/\/github\.com\/|github:|git@github\.com:)BeeTrain\/p4p(?:\.git)?(?:#.*)?$/i.test(spec)) return true;
      if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('file:')) return false;
      let path: string;
      try { path = spec.startsWith('file:') ? fileURLToPath(spec) : resolve(dirname(target), spec); }
      catch { return false; }
      if (path === root) return true;
      try { return JSON.parse(await readFile(join(path, 'package.json'), 'utf8')).name === 'p4p'; }
      catch { return false; }
    };
    const flags = await Promise.all(plugins.map(related));
    const prior = plugins.find((item, index) => flags[index] && item && typeof item === 'object');
    const previousOptions = prior?.options && typeof prior.options === 'object' ? prior.options : {};
    const configFile = !config && !process.env.P4P_CONFIG && typeof previousOptions.config === 'string' ? previousOptions.config : store.path;
    const entry = { package: root, options: { ...previousOptions, config: configFile } };
    const filtered = plugins.filter((_item, index) => !flags[index]);
    const updated = applyEdits(text, modify(text, ['plugins'], [...filtered, entry], { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, updated, { mode: 0o600 });
    print({ opencode: target, plugin: root, config: configFile, next: 'Перезапустите OpenCode. Настройки p4p находятся в Settings → p4p и команде p4p.' }); return;
  }
  throw new Error(`Неизвестная команда: ${command}. См. p4p help.`);
}
main().catch(error => { process.stderr.write(`p4p: ${error instanceof Error ? error.message : 'Ошибка.'}\n`); process.exitCode = 1; });

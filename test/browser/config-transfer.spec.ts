import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const choose = (settings: unknown) => ({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(settings)) });
test('import stages validated fields, export includes the draft, save applies it and invalid imports leave everything intact', async ({ page, request }) => {
  const initial = await (await request.post('/__p4p/get', { data: {} })).json();
  const saved = { ...initial.settings, enabled: true, patterns: ['before'], hosts: ['before.example.test'], diagnostics: { logs: true, stacktraces: true, marked: true, heuristics: true, tool_output: false } };
  await request.post('/__p4p/save', { data: { settings: saved, revision: initial.revision } });
  await page.goto('/test/preview/');
  await expect(page.getByLabel('Слова и регулярные выражения')).toHaveValue('before');
  const imported = { ...saved, enabled: false, patterns: ['(?i)private', 'user-\\d+'], hosts: ['api.example.test'], diagnostics: { logs: false, stacktraces: false, marked: false, heuristics: true, tool_output: true } };
  await expect(page.getByLabel('Файл конфигурации', { exact: true })).toBeHidden();
  const picker = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Импорт JSON', exact: true }).click();
  await (await picker).setFiles(choose(imported));
  await expect(page.getByRole('status')).toContainText('Для применения');
  await expect(page.getByLabel('Слова и регулярные выражения')).toHaveValue(imported.patterns.join('\n'));
  expect((await (await request.post('/__p4p/get', { data: {} })).json()).settings).toEqual(saved);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Экспорт JSON', exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toBe('p4p-config.json');
  expect(JSON.parse(await readFile((await file.path())!, 'utf8'))).toEqual(imported);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Сохранено');
  expect((await (await request.post('/__p4p/get', { data: {} })).json()).settings).toEqual(imported);
  await page.getByLabel('Файл конфигурации', { exact: true }).setInputFiles(choose({ ...imported, patterns: ['['] }));
  await expect(page.getByRole('alert')).toContainText('Регулярное выражение');
  await expect(page.getByLabel('Слова и регулярные выражения')).toHaveValue(imported.patterns.join('\n'));
  expect((await (await request.post('/__p4p/get', { data: {} })).json()).settings).toEqual(imported);
  await page.getByLabel('Слова и регулярные выражения').fill('unsaved');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByLabel('Файл конфигурации', { exact: true }).setInputFiles(choose(saved));
  await expect(page.getByRole('button', { name: 'Экспорт JSON', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Слова и регулярные выражения')).toHaveValue('unsaved');
});

test('the Desktop settings window exports through the host file API and reflects an imported saved toggle above the composer', async ({ page, request }) => {
  const initial = await (await request.post('/__p4p/get', { data: {} })).json();
  const saved = { ...initial.settings, enabled: true, patterns: ['initial'], hosts: ['api.example.test'] };
  await request.post('/__p4p/save', { data: { settings: saved, revision: initial.revision } });
  await page.goto('/test/preview/composer.html');
  await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки p4p' }); await expect(dialog.getByLabel('Слова и регулярные выражения')).toHaveValue('initial');
  await dialog.getByLabel('Файл конфигурации', { exact: true }).setInputFiles(choose({ ...saved, enabled: false }));
  await expect(dialog.getByRole('status')).toContainText('Для применения');
  const download = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Экспорт JSON', exact: true }).click();
  const file = await download; expect(JSON.parse(await readFile((await file.path())!, 'utf8')).enabled).toBe(false);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog.getByRole('status')).toContainText('Сохранено');
  await expect(page.getByRole('button', { name: /^p4p: Включить маскирование p4p/ })).toBeVisible();
});

import { test, expect } from '@playwright/test';

test('Desktop settings use 80% height, keep header actions visible and expose help to keyboard users', async ({ page, request }) => {
  const initial = await (await request.post('/__p4p/get', { data: {} })).json();
  await request.post('/__p4p/save', { data: { settings: { ...initial.settings, enabled: true, recordRequests: true, patterns: ['private'], hosts: ['api.example.test'] }, revision: initial.revision } });
  await page.goto('/test/preview/composer.html');
  await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки p4p' });
  await expect(dialog.getByLabel('Слова и регулярные выражения')).toHaveValue('private');
  const bounds = await dialog.boundingBox();
  expect(bounds!.height).toBeCloseTo(page.viewportSize()!.height * .8, 0);
  const toolbar = dialog.locator('.p4p-toolbar');
  const toggleBounds = await toolbar.getByText('Маскирование', { exact: true }).boundingBox();
  const importBounds = await toolbar.getByRole('button', { name: 'Импорт JSON', exact: true }).boundingBox();
  expect(Math.abs(toggleBounds!.y + toggleBounds!.height / 2 - importBounds!.y - importBounds!.height / 2)).toBeLessThan(2);
  const info = dialog.getByRole('button', { name: 'О разделе «Словарь»', exact: true });
  await info.focus();
  await expect(dialog.getByRole('tooltip')).toContainText('Python regex');
  await info.press('Escape');
  await expect(dialog.getByRole('tooltip')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  const header = dialog.locator('.p4p-heading');
  const headerBefore = await header.boundingBox();
  await dialog.locator('.p4p-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(dialog.getByRole('region', { name: 'Журнал запросов' })).toBeVisible();
  const headerAfter = await header.boundingBox();
  expect(headerAfter!.y).toBe(headerBefore!.y);
  await expect(header.getByRole('button', { name: 'Сохранить', exact: true })).toBeInViewport();
  await expect(header.getByRole('button', { name: 'Перезагрузить', exact: true })).toBeInViewport();
  await dialog.getByLabel('Записывать запросы', { exact: true }).uncheck();
  await header.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Сохранено');
  expect((await (await request.post('/__p4p/get', { data: {} })).json()).settings.recordRequests).toBe(false);
  await expect(dialog.getByText('Запись выключена.', { exact: false })).toBeVisible();
  await dialog.locator('.p4p-content').evaluate(element => { element.scrollTop = 0; });
  const badge = dialog.getByLabel('Статус плагина', { exact: true });
  await expect(badge).toHaveClass(/p4p-badge-enabled/);
  await dialog.screenshot({ path: 'test-results/settings-desktop-enabled.png' });
  await dialog.getByLabel('Включить маскирование', { exact: true }).uncheck();
  await expect(badge).toContainText('Включён');
  await header.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(badge).toContainText('Выключен');
  await expect(badge).not.toHaveClass(/p4p-badge-enabled/);
  await dialog.screenshot({ path: 'test-results/settings-desktop.png' });
  await page.setViewportSize({ width: 420, height: 800 });
  const narrow = await dialog.boundingBox();
  expect(narrow!.height).toBeCloseTo(640, 0);
  await expect(header.getByRole('button', { name: 'Сохранить', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.screenshot({ path: 'test-results/settings-desktop-narrow.png' });
});

test('request journal shows compact rows with distinct status labels and lights', async ({ page, request }) => {
  await request.post('/__p4p/clearFailures', { data: {} });
  const statuses = ['succeeded', 'failed', 'unknown'];
  for (const [index, status] of statuses.entries()) await request.post('/__p4p/seedFailure', { data: {
    id: String(index + 1).repeat(24), source: 'http', status, session_id: 'layout-fixture', provider: 'local', model: 'fixture-model', role: 'build', operation: 'primary', started_at: Date.now() / 1000,
    endpoint: 'https://example.test', request: {}, coverage: 'Fixture', attempt: 1, previous_request_id: null, ...(status === 'failed' ? { http_status: 422, error: { message: 'Synthetic error' } } : status === 'succeeded' ? { http_status: 200 } : {})
  } });
  await page.goto('/test/preview/');
  const history = page.getByRole('region', { name: 'Журнал запросов' });
  await history.scrollIntoViewIfNeeded();
  await expect(history.locator('tbody tr')).toHaveCount(3);
  await expect(history).toContainText('Успешно');
  await expect(history).toContainText('Ошибка');
  await expect(history).toContainText('Без результата');
  const colors = [];
  for (const status of statuses) {
    const light = history.locator(`[data-status="${status}"] .p4p-status-light`);
    colors.push(await light.evaluate(element => getComputedStyle(element).backgroundColor));
  }
  expect(new Set(colors).size).toBe(3);
  expect((await history.locator('tbody tr').first().boundingBox())!.height).toBeLessThanOrEqual(44);
  await history.screenshot({ path: 'test-results/request-journal.png' });
});

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const surface of ['panel', 'bundle']) test(`journal logging mode persists after save and reload: ${surface}`, async ({ page, request }) => {
  const before = await (await request.post('/__p4p/get', { data: {} })).json();
  const initial = { ...before.settings, recordRequests: true, requestLogFilter: 'all' };
  await request.post('/__p4p/save', { data: { settings: initial, revision: before.revision } });
  const open = async () => {
    await page.goto(surface === 'panel' ? '/test/preview/' : '/test/preview/composer.html?bundle');
    if (surface !== 'panel') await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
  };
  await open();
  const filter = page.getByRole('combobox', { name: 'Логировать:' });
  await expect(filter.locator('option')).toHaveText(['Все запросы', 'Успешные', 'Неуспешные']);
  for (const value of ['failed', 'succeeded', 'all']) {
    await filter.selectOption(value);
    if (value !== 'all') {
      await expect(page.getByText('Изменение записи применится после сохранения настроек.')).toBeVisible();
      expect((await (await request.post('/__p4p/get', { data: {} })).json()).settings.requestLogFilter).not.toBe(value);
    }
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Сохранено');
    const persisted = (await (await request.post('/__p4p/get', { data: {} })).json()).settings;
    expect(persisted).toEqual({ ...initial, requestLogFilter: value });
    await open(); await expect(filter).toHaveValue(value);
  }
  await page.getByLabel('Записывать запросы', { exact: true }).uncheck();
  await expect(filter).toBeDisabled();
  await page.getByLabel('Записывать запросы', { exact: true }).check();
  await expect(filter).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(filter).toBeVisible();
  expect(await filter.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
});

for (const desktop of [false, true]) test(`failed request JSON download and history clearing ${desktop ? 'through Desktop host' : 'in settings panel'}`, async ({ page, request }) => {
  await request.post('/__p4p/clearFailures', { data: {} });
  const before = await (await request.post('/__p4p/get', { data: {} })).json();
  const id = '1234567890abcdef12345678';
  await request.post('/__p4p/seedFailure', { data: { id, source: 'http', status: 'failed', session_id: 'session-ui-fixture', model: 'fixture-model', provider: 'local', role: 'build', operation: 'primary', started_at: Date.now() / 1000, endpoint: 'https://example.test/v1', request: { messages: [{ role: 'user', content: 'synthetic request' }], api_key: 'fixture-credential' }, masked_request: { messages: [] }, error: { message: 'Synthetic test error' }, http_status: 422, coverage: 'Fixture', attempt: 1, previous_request_id: null } });
  await page.goto(desktop ? '/test/preview/composer.html' : '/test/preview/');
  if (desktop) await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
  const history = page.getByRole('region', { name: 'Журнал запросов' });
  await expect(history).toContainText('HTTP 422'); await expect(history).toContainText('Synthetic test error');
  const download = page.waitForEvent('download'); await history.getByRole('button', { name: `Скачать JSON запроса ${id}`, exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toBe(`model-request-${id}.json`);
  const content = await readFile((await file.path())!, 'utf8'), row = JSON.parse(content);
  expect(row.request.messages[0].content).toBe('synthetic request'); expect(row.error.message).toBe('Synthetic test error'); expect(row.http_status).toBe(422);
  expect(content).not.toContain('fixture-credential');
  page.once('dialog', dialog => dialog.dismiss()); await history.getByRole('button', { name: 'Очистить журнал' }).click();
  await expect(history).toContainText('HTTP 422');
  page.once('dialog', dialog => dialog.accept()); await history.getByRole('button', { name: 'Очистить журнал' }).click();
  await expect(history).toContainText('В журнале пока нет запросов.');
  expect((await (await request.post('/__p4p/get', { data: {} })).json()).revision).toBe(before.revision);
});

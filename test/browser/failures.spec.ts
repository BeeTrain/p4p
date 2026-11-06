import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const desktop of [false, true]) test(`failed request JSON download and history clearing ${desktop ? 'through Desktop host' : 'in settings panel'}`, async ({ page, request }) => {
  await request.post('/__p4p/clearFailures', { data: {} });
  const before = await (await request.post('/__p4p/get', { data: {} })).json();
  const id = '1234567890abcdef12345678';
  await request.post('/__p4p/seedFailure', { data: { id, source: 'http', status: 'failed', session_id: 'session-ui-fixture', model: 'fixture-model', provider: 'local', role: 'build', operation: 'primary', started_at: Date.now() / 1000, endpoint: 'https://example.test/v1', request: { messages: [{ role: 'user', content: 'synthetic request' }], api_key: 'fixture-credential' }, masked_request: { messages: [] }, error: { message: 'Synthetic test error' }, http_status: 422, coverage: 'Fixture', attempt: 1, previous_request_id: null } });
  await page.goto(desktop ? '/test/preview/composer.html' : '/test/preview/');
  if (desktop) await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
  const history = page.getByRole('region', { name: 'Неуспешные запросы' });
  await expect(history).toContainText('HTTP 422'); await expect(history).toContainText('Synthetic test error');
  const download = page.waitForEvent('download'); await history.getByRole('button', { name: `Скачать JSON запроса ${id}`, exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toBe(`model-request-${id}.json`);
  const content = await readFile((await file.path())!, 'utf8'), row = JSON.parse(content);
  expect(row.request.messages[0].content).toBe('synthetic request'); expect(row.error.message).toBe('Synthetic test error'); expect(row.http_status).toBe(422);
  expect(content).not.toContain('fixture-credential');
  page.once('dialog', dialog => dialog.dismiss()); await history.getByRole('button', { name: 'Очистить журнал' }).click();
  await expect(history).toContainText('HTTP 422');
  page.once('dialog', dialog => dialog.accept()); await history.getByRole('button', { name: 'Очистить журнал' }).click();
  await expect(history).toContainText('Неуспешных запросов пока нет.');
  expect((await (await request.post('/__p4p/get', { data: {} })).json()).revision).toBe(before.revision);
});

import { test, expect } from '@playwright/test';

for (const surface of ['panel', 'desktop', 'bundle']) {
  test(`${surface}: every checkbox persists in both directions after save and reload`, async ({ page, request }) => {
    const initial = await (await request.post('/__p4p/get', { data: {} })).json();
    const saved = { ...initial.settings, enabled: false, recordRequests: false, patterns: ['private'], hosts: ['api.example.test'], diagnostics: { logs: false, stacktraces: false, marked: false, heuristics: false, tool_output: false } };
    await request.post('/__p4p/save', { data: { settings: saved, revision: initial.revision } });
    const open = async () => {
      await page.goto(surface === 'panel' ? '/test/preview/' : `/test/preview/composer.html${surface === 'bundle' ? '?bundle' : ''}`);
      if (surface !== 'panel') await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
      await expect(page.getByLabel('Слова и регулярные выражения')).toHaveValue('private');
    };
    await open();
    for (const checked of [true, false]) {
      const checkboxes = page.getByRole('checkbox');
      await expect(checkboxes).toHaveCount(7);
      for (const checkbox of await checkboxes.all()) await checkbox.setChecked(checked);
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Сохранено');
      for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeChecked({ checked });
      const persisted = (await (await request.post('/__p4p/get', { data: {} })).json()).settings;
      expect(persisted).toEqual({ ...saved, enabled: checked, recordRequests: checked, diagnostics: Object.fromEntries(Object.keys(saved.diagnostics).map(key => [key, checked])) });
      await open();
      for (const checkbox of await page.getByRole('checkbox').all()) await expect(checkbox).toBeChecked({ checked });
    }
  });
}

for (const method of ['get', 'save']) {
  test(`an outdated server response from ${method} reports incompatibility and never resets the draft`, async ({ page, request }) => {
    const initial = await (await request.post('/__p4p/get', { data: {} })).json();
    const saved = { ...initial.settings, recordRequests: false, patterns: ['private'] };
    await request.post('/__p4p/save', { data: { settings: saved, revision: initial.revision } });
    await page.route(`**/__p4p/${method}`, async route => {
      const response = await route.fetch();
      const view = await response.json();
      delete view.settings.recordRequests;
      await route.fulfill({ response, json: view });
    });
    await page.goto('/test/preview/composer.html?bundle');
    await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
    if (method === 'save') {
      await page.getByLabel('Записывать запросы', { exact: true }).check();
      await page.getByLabel('Слова и регулярные выражения').fill('draft');
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    }
    await expect(page.getByRole('alert')).toContainText('Перезапустите сервер OpenCode');
    await expect(page.getByRole('status')).toHaveCount(0);
    if (method === 'save') {
      await expect(page.getByLabel('Записывать запросы', { exact: true })).toBeChecked();
      await expect(page.getByLabel('Слова и регулярные выражения')).toHaveValue('draft');
      await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
    } else {
      await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
      await page.unroute('**/__p4p/get');
      await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
      await expect(page.getByLabel('Записывать запросы', { exact: true })).not.toBeChecked();
    }
  });
}

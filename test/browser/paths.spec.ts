import { test, expect } from '@playwright/test';

for (const surface of ['panel', 'bundle']) {
  test(`${surface}: path modes preview locally, persist and restore the original path`, async ({ page, request }) => {
    const initial = await (await request.post('/__p4p/get', { data: {} })).json();
    await request.post('/__p4p/save', { data: { settings: { ...initial.settings, enabled: true, patterns: [], paths: { enabled: false, mode: 'roots', roots: [] } }, revision: initial.revision } });
    const open = async () => {
      await page.goto(surface === 'panel' ? '/test/preview/' : '/test/preview/composer.html?bundle');
      if (surface === 'bundle') await page.getByRole('button', { name: 'Настройки p4p', exact: true }).click();
      await expect(page.getByLabel('Корневые каталоги для маскирования')).toBeVisible();
    };
    await open();
    await page.getByRole('checkbox', { name: /^Маскировать пути/ }).check();
    await page.getByLabel('Корневые каталоги для маскирования').fill('/Users/max/projects/app/');
    const original = '/Users/max/projects/app/src/main.ts';
    await page.getByLabel('Текст для проверки').fill(original);
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(page.getByLabel('После маскирования')).toHaveValue(/^__P4P_\w+__\/src\/main\.ts$/);
    await expect(page.getByLabel('После восстановления')).toHaveValue(original);
    await page.getByLabel('Способ маскирования путей').selectOption('components');
    await expect(page.getByLabel('После маскирования')).toHaveCount(0);
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(page.getByLabel('После маскирования')).toHaveValue(/^(?:\/__P4P_[0-9a-f]{24}_\d+__){6}\.ts$/);
    await expect(page.getByLabel('После восстановления')).toHaveValue(original);
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Сохранено');
    const saved = (await (await request.post('/__p4p/get', { data: {} })).json()).settings;
    expect(saved.paths).toEqual({ enabled: true, mode: 'components', roots: ['/Users/max/projects/app'] });
    await open();
    await expect(page.getByRole('checkbox', { name: /^Маскировать пути/ })).toBeChecked();
    await expect(page.getByLabel('Способ маскирования путей')).toHaveValue('components');
    await expect(page.getByLabel('Корневые каталоги для маскирования')).toHaveValue('/Users/max/projects/app');
    await page.setViewportSize({ width: 420, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (surface === 'bundle') await page.getByRole('dialog').screenshot({ path: 'test-results/paths-settings.png' });
  });
}

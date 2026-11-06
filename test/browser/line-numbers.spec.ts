import { test, expect } from '@playwright/test';

test('номера строк учитывают пустые строки и синхронно прокручиваются во всех трёх полях', async ({ page, request }) => {
  const initial = await (await request.post('/__p4p/get', { data: {} })).json();
  await request.post('/__p4p/save', { data: { settings: { ...initial.settings, patterns: [], hosts: [] }, revision: initial.revision } });
  await page.goto('/test/preview/');
  for (const label of ['Слова и регулярные выражения', 'Применять к хостам', 'Текст для проверки']) {
    const input = page.getByLabel(label, { exact: true });
    const editor = page.locator('.p4p-numbered-textarea').filter({ has: input });
    const gutter = editor.locator('.p4p-line-numbers');
    await expect(gutter).toHaveText('1');
    await expect(gutter).toHaveAttribute('aria-hidden', 'true');
    await input.fill('first\n\nlast\n');
    await expect(gutter).toHaveText('1\n2\n3\n4');
    await input.press('ControlOrMeta+End');
    await input.press('Enter');
    await expect(gutter).toHaveText('1\n2\n3\n4\n5');
    await input.press('Backspace');
    await expect(gutter).toHaveText('1\n2\n3\n4');
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index + 1}-${'x'.repeat(200)}`);
    await input.fill(lines.join('\n'));
    await expect(gutter).toHaveText(Array.from({ length: 120 }, (_, index) => index + 1).join('\n'));
    await input.evaluate(element => { element.scrollTop = 200; element.scrollLeft = 150; });
    await expect.poll(() => editor.evaluate(element => {
      const textarea = element.querySelector('textarea')!;
      const numbers = element.querySelector<HTMLElement>('.p4p-line-numbers > div')!;
      const gutter = numbers.parentElement!;
      return { scrolled: textarea.scrollTop > 0 && textarea.scrollLeft > 0, offset: Math.round(numbers.getBoundingClientRect().top - gutter.getBoundingClientRect().top + textarea.scrollTop) };
    })).toEqual({ scrolled: true, offset: 0 });
    await input.evaluate(element => { element.style.height = '180px'; element.scrollTop = element.scrollHeight; });
    await expect.poll(() => editor.evaluate(element => {
      const textarea = element.querySelector('textarea')!;
      const numbers = element.querySelector<HTMLElement>('.p4p-line-numbers > div')!;
      return Math.round(numbers.getBoundingClientRect().top - numbers.parentElement!.getBoundingClientRect().top + textarea.scrollTop);
    })).toBe(0);
    await input.fill('reset');
    await expect(gutter).toHaveText('1');
    await expect.poll(() => gutter.locator('div').evaluate(element => Math.round(element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top))).toBe(0);
  }
  await page.setViewportSize({ width: 420, height: 1000 });
  await expect(page.locator('.p4p-numbered-textarea')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

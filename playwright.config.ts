import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:42617', channel: 'chrome', viewport: { width: 1100, height: 1000 } },
  webServer: { command: 'node test/preview-server.mjs', url: 'http://127.0.0.1:42617/test/preview/', reuseExistingServer: false },
});

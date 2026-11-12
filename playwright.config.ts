import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 45000,
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [
    {name:'desktop-chromium',use:{...devices['Desktop Chrome']}},
    {name:'desktop-webkit',use:{...devices['Desktop Safari']}},
    {name:'mobile-webkit',use:{...devices['iPhone 13']}},
  ],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});

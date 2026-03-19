const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5174',
    headless: false,
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
  },
});

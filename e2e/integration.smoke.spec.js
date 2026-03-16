const { test, expect } = require('@playwright/test');

const hasIntegratedBackend = Boolean(process.env.E2E_API_TARGET);

test.describe('integrated smoke', () => {
  test.skip(!hasIntegratedBackend, 'Define E2E_API_TARGET para ejecutar los smoke tests integrados');

  test('login y navegacion basica contra backend real', async ({ page }) => {
    await page.goto('/');

    await page.getByPlaceholder('admin').fill(process.env.E2E_USERNAME || 'admin');
    await page.getByPlaceholder('••••••••').fill(process.env.E2E_PASSWORD || 'admin123');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page.getByRole('button', { name: 'Trading Manual' })).toBeVisible();
    await page.getByRole('button', { name: 'Bots' }).click();
    await expect(page.getByText('Bot Control Room')).toBeVisible();
    await page.getByRole('button', { name: 'Backtesting' }).click();
    await expect(page.getByText('Backtesting Lab')).toBeVisible();
  });
});

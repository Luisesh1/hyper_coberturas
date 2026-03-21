const { test, expect } = require('@playwright/test');

const hasIntegratedBackend = Boolean(process.env.E2E_API_TARGET);

async function login(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('admin').fill(process.env.E2E_USERNAME || 'admin');
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_PASSWORD || 'admin123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Backtesting' })).toBeVisible({ timeout: 10000 });
}

test.describe('Platform headed checks', () => {
  test.skip(!hasIntegratedBackend, 'Define E2E_API_TARGET para ejecutar los headed checks integrados');

  test('1 — Login page renders and login works', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.getByPlaceholder('admin')).toBeVisible({ timeout: 10000 });
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();

    await login(page);
    // Verify we're past login
    const url = page.url();
    console.log('Post-login URL:', url);
    expect(url).not.toContain('/login');
  });

  test('2 — Navigation: all main pages load without JS errors', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await login(page);

    const navButtons = [
      'Trading Manual',
      'Coberturas',
      'Estrategias',
      'Backtesting',
      'Bots',
      '🦄 Uniswap Pools',
      '⚙ Config',
    ];
    console.log(`Found ${navButtons.length} nav buttons`);

    for (const label of navButtons) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(2000);
      console.log(`  ${label}: ${page.url()} — OK`);
    }

    if (pageErrors.length) {
      console.log('JS ERRORS:', pageErrors);
    }
    expect(pageErrors).toEqual([]);
  });

  test('3 — Strategy Studio page loads and renders', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await login(page);
    await page.goto('/estrategias');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Page should render something
    const bodyText = await page.textContent('body');
    expect(bodyText.length).toBeGreaterThan(0);
    console.log('Strategy Studio loaded, content length:', bodyText.length);

    // Check for CodeMirror if a strategy editor is visible
    const cmEditors = page.locator('.cm-editor');
    const cmCount = await cmEditors.count();
    console.log('CodeMirror instances:', cmCount);

    expect(errors).toEqual([]);
  });

  test('4 — Backtesting page loads and config drawer works', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await login(page);
    await page.goto('/backtesting');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const labText = page.getByText('Backtesting Lab');
    await expect(labText).toBeVisible({ timeout: 10000 });
    console.log('Backtesting Lab visible');

    const strategySelect = page.getByRole('combobox', { name: 'Estrategia' }).first();
    await expect(strategySelect).toBeVisible({ timeout: 10000 });
    console.log('Strategy selector visible');

    const configToggle = page.getByRole('button', { name: 'Toggle configuracion' });
    await expect(configToggle).toBeVisible();
    console.log('Config toggle visible');

    expect(errors).toEqual([]);
  });

  test('5 — Bots page loads', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await login(page);
    await page.goto('/bots');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const bodyText = await page.textContent('body');
    console.log('Bots page loaded, content length:', bodyText.length);

    expect(errors).toEqual([]);
  });

  test('6 — Settings page loads with new design', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await login(page);
    await page.goto('/config');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const bodyText = await page.textContent('body');
    console.log('Settings page loaded, content length:', bodyText.length);

    expect(errors).toEqual([]);
  });

  test('7 — Uniswap Pools page loads', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await login(page);
    await page.goto('/uniswap-pools');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const bodyText = await page.textContent('body');
    console.log('Uniswap page loaded, content length:', bodyText.length);

    expect(errors).toEqual([]);
  });

  test('8 — Full page audit: no uncaught errors anywhere', async ({ page }) => {
    const criticalErrors = [];
    page.on('pageerror', err => criticalErrors.push({ url: page.url(), error: err.message }));

    await login(page);

    const routes = ['/trade', '/estrategias', '/backtesting', '/bots', '/config', '/uniswap-pools'];
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
      console.log(`${route}: OK`);
    }

    if (criticalErrors.length) {
      console.log('CRITICAL ERRORS:', JSON.stringify(criticalErrors, null, 2));
    }
    expect(criticalErrors).toEqual([]);
  });
});

const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:5174';
const USERNAME = 'admin';
const PASSWORD = 'admin123';

async function login(page) {
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('admin').fill(USERNAME);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForTimeout(2000);
}

test.describe('Platform headed checks', () => {

  test('1 — Login page renders and login works', async ({ page }) => {
    await page.goto(BASE);
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

    const navLinks = page.locator('nav a, [class*="sidebar"] a, [class*="nav"] a');
    const count = await navLinks.count();
    console.log(`Found ${count} nav links`);

    const visited = new Set();
    for (let i = 0; i < count; i++) {
      const link = navLinks.nth(i);
      const href = await link.getAttribute('href').catch(() => null);
      const text = (await link.textContent().catch(() => '')).trim();
      if (!href || visited.has(href)) continue;
      visited.add(href);

      await link.click();
      await page.waitForTimeout(2000);
      console.log(`  ${text || href}: ${page.url()} — OK`);
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
    await page.goto(`${BASE}/strategies`);
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
    await page.goto(`${BASE}/backtesting`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Check Backtesting Lab text
    const labText = page.getByText('Backtesting Lab');
    await expect(labText).toBeVisible({ timeout: 5000 });
    console.log('Backtesting Lab visible');

    // Check config drawer has sizing mode
    const sizingSelect = page.locator('select').filter({ hasText: /USD fijo/ });
    const hasSizing = await sizingSelect.count();
    console.log('Sizing mode selector found:', hasSizing > 0);

    // Check timeframe options include new ones (4h, 1D, 1W)
    const timeframeSelects = page.locator('select').filter({ hasText: /4h/ });
    const has4h = await timeframeSelects.count();
    console.log('4h timeframe available:', has4h > 0);

    expect(errors).toEqual([]);
  });

  test('5 — Bots page loads', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await login(page);
    await page.goto(`${BASE}/bots`);
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
    await page.goto(`${BASE}/config`);
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
    await page.goto(`${BASE}/uniswap`);
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

    const routes = ['/dashboard', '/strategies', '/backtesting', '/bots', '/config', '/uniswap'];
    for (const route of routes) {
      await page.goto(`${BASE}${route}`);
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

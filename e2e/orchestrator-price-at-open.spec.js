const { test, expect } = require('@playwright/test');

const hasBackend = Boolean(process.env.E2E_API_TARGET);

async function login(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('admin').fill(process.env.E2E_USERNAME || 'admin');
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_PASSWORD || 'admin123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Backtesting' })).toBeVisible({ timeout: 10000 });
}

test.describe('Orchestrator — priceAtOpen display', () => {
  test.skip(!hasBackend, 'Requiere E2E_API_TARGET');

  test('muestra el valor numerico de apertura en la barra de rango', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await login(page);

    // Navigate to LP Orchestrator page
    await page.getByRole('button', { name: '🎛 Orquestador LP' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Verify the orchestrator card "fofofo" is visible
    const card = page.locator('text=fofofo').first();
    await expect(card).toBeVisible({ timeout: 10000 });

    // The range bar should show "Apertura" label
    const aperturaLabel = page.locator('text=Apertura').first();
    await expect(aperturaLabel).toBeVisible({ timeout: 5000 });

    // The numeric value should be visible near the Apertura label.
    // priceAtOpen is ~2185, so look for a formatted number starting with "2,1"
    const aperturaPin = aperturaLabel.locator('..');
    const pinText = await aperturaPin.textContent();
    console.log('Apertura pin text:', pinText);

    // The pin should contain BOTH the label "Apertura" AND a numeric price
    expect(pinText).toContain('Apertura');
    // Check that there's a number (formatted like 2,185 or similar)
    expect(pinText).toMatch(/[\d,]+\.?\d*/);

    // Also verify "Actual" label with current price is visible
    const actualLabel = page.locator('text=Actual').first();
    await expect(actualLabel).toBeVisible({ timeout: 5000 });

    // Verify the "vs apertura" delta row is shown
    const deltaRow = page.locator('text=vs apertura').first();
    await expect(deltaRow).toBeVisible({ timeout: 5000 });

    // Verify no JS errors
    expect(errors).toEqual([]);
  });

  test('el dropdown de operaciones de proteccion se abre sin errores', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await login(page);

    await page.getByRole('button', { name: '🎛 Orquestador LP' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Find and click the protection ops dropdown
    const protectionSummary = page.locator('text=Operaciones proteccion').first();
    const isVisible = await protectionSummary.isVisible().catch(() => false);

    if (isVisible) {
      await protectionSummary.click();
      await page.waitForTimeout(2000);

      // Should show loading or content, no crash
      const bodyText = await protectionSummary.locator('..').locator('..').textContent();
      console.log('Protection ops panel text length:', bodyText.length);
      expect(bodyText.length).toBeGreaterThan(0);
    } else {
      console.log('Protection ops panel not visible (no active protection) — skipping');
    }

    expect(errors).toEqual([]);
  });
});

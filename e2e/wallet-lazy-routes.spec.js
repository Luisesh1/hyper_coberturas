const { test, expect } = require('@playwright/test');

/**
 * El stack wallet (wagmi/viem/WalletConnect) ya no va en la carga inicial: sólo
 * lo monta WalletLayout en /uniswap-pools, /lp-orchestrator, /contratos y
 * /hidenActions. Que `vendor-wallet` no se descargue al arrancar lo cubre
 * `npm run check:bundle` (en dev Vite no genera chunks).
 *
 * Hermético: mockea la API como metrics-wallet-orchestrators.spec.js.
 */

async function mockApi(page) {
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const json = (data) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
    return json([]);
  });
}

// Errores reales de la app: se ignoran los fallos de red de recursos que el
// mock no cubre (WebSocket, favicon...).
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource|WebSocket|net::ERR/i.test(text)) return;
    errors.push(text);
  });
  return errors;
}

async function irA(page, label) {
  const hamburger = page.getByRole('button', { name: 'Abrir menú' });
  if (await hamburger.isVisible()) await hamburger.click();
  await page.getByRole('button', { name: label }).locator('visible=true').first().click();
}

for (const vp of [{ name: 'escritorio', width: 1400, height: 900 }, { name: 'móvil', width: 390, height: 844 }]) {
  test.describe(vp.name, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockApi(page);
    });

    test('/trade renderiza sin WalletProvider', async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto('/trade');
      await expect(page).toHaveURL(/\/trade$/);
      await expect(page.locator('main')).toBeVisible({ timeout: 15000 });
      await page.waitForLoadState('networkidle');
      expect(errors).toEqual([]);
    });

    test('navegar entre páginas de wallet no vuelve a montar el provider', async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto('/lp-orchestrator');
      await expect(page).toHaveURL(/\/lp-orchestrator$/);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => { window.__mark = 1; });

      await irA(page, /Uniswap Pools/);
      await expect(page).toHaveURL(/\/uniswap-pools$/);
      expect(await page.evaluate(() => window.__mark)).toBe(1);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('main')).toBeVisible();
      expect(await page.locator('main').innerText()).not.toBe('');
      expect(errors).toEqual([]);
    });

    test('entrar por enlace directo a /contratos funciona', async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto('/contratos');
      await expect(page).toHaveURL(/\/contratos$/);
      await expect(page.getByRole('heading', { name: 'Hooks y versiones' })).toBeVisible({ timeout: 15000 });
      expect(errors).toEqual([]);
    });
  });
}

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

test.describe('Orquestador — LP sin cobertura', () => {
  test.skip(!hasBackend, 'Requiere E2E_API_TARGET');

  test('pinta el chip "Sin cobertura" cuando el LP activo no tiene proteccion vinculada', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Interceptamos la lista para forzar el estado descubierto sin depender
    // de que haya un orquestador roto de verdad en la base de datos.
    await page.route('**/api/lp-orchestrators', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const rows = Array.isArray(body?.data) ? body.data : [];
      if (rows.length > 0) {
        rows[0].activePositionIdentifier = '191720';
        rows[0].activeProtectedPoolId = null;
        rows[0].protectionConfig = { enabled: true, accountId: 8, configuredNotionalUsd: 50 };
        rows[0].strategyState = {
          ...(rows[0].strategyState || {}),
          protectionRetry: { attempts: 2, nextAttemptAt: Date.now() + 600000, lastError: 'margen insuficiente' },
        };
        rows[0].phase = 'lp_active';
        rows[0].lastError = null;
      }
      await route.fulfill({ response, json: body });
    });

    await login(page);
    await page.getByRole('button', { name: '🎛 Orquestador LP' }).click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Sin cobertura').first()).toBeVisible({ timeout: 10000 });

    expect(errors).toEqual([]);
  });
});

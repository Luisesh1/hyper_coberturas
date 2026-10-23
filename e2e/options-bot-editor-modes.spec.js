const { test, expect } = require('@playwright/test');

// Editor de bots · selector Simple / Avanzado / Presets y cierre solo con
// Guardar o Cancelar (pulsar fuera no cierra). /api mockeada.

const ALERT_UP = { id: 11, name: 'BTC · MACD cruce alcista 15m', direction: 'bullish', assetList: ['BTCUSDT'], thresholdPercent: 70 };

async function mockApi(page, state) {
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({ id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser' }));
    localStorage.removeItem('options.botEditorMode');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    if (pathname === '/api/options/underlyings') return json([{ underlying: 'BTC', spot: 68000, change24hPct: 1.2 }]);
    if (pathname === '/api/options/auto-bots/eligible-alerts') return json([ALERT_UP]);
    if (pathname === '/api/options/auto-bots' && method === 'POST') {
      state.created = route.request().postDataJSON();
      return json({ id: 7, template: 'alert_signal', mode: 'shadow', limits: {}, alerts: [ALERT_UP], ...state.created }, 201);
    }
    return json([]);
  });
}

async function horizontalOverflow(page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

async function run(page, shot) {
  const state = {};
  await mockApi(page, state);
  await page.goto('/opciones?tab=auto');
  await page.getByRole('button', { name: 'Nuevo bot' }).first().click();
  const form = page.getByRole('dialog', { name: 'Nuevo bot' });
  await expect(form.getByRole('radio', { name: 'Simple' })).toHaveAttribute('aria-checked', 'true');
  await expect(form.getByLabel(/Riesgo por operación/)).toBeVisible();

  // Pulsar fuera no cierra.
  await page.mouse.click(5, 5);
  await expect(form).toBeVisible();

  await form.getByRole('radio', { name: 'Presets' }).click();
  await form.getByRole('radio', { name: /Rápido/ }).click();
  await expect(form.getByRole('radio', { name: /Rápido/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: `test-results/${shot}-presets.png`, fullPage: false });

  await form.getByRole('radio', { name: 'Simple' }).click();
  await expect(form.getByRole('radio', { name: 'Cercano' })).toHaveAttribute('aria-checked', 'true');
  await expect(form.getByText('Preset: Rápido')).toBeVisible();
  await form.getByLabel('Nombre').fill('Bot simple');
  await form.getByLabel(/Riesgo por operación/).fill('10');
  await form.getByRole('checkbox', { name: new RegExp(ALERT_UP.name) }).click();
  await expect(form.getByText(/arriesgando hasta 10 USDT/)).toBeVisible();
  await page.screenshot({ path: `test-results/${shot}-simple.png`, fullPage: false });
  expect(await horizontalOverflow(page)).toBe(0);

  await form.getByRole('radio', { name: 'Avanzado' }).click();
  await expect(form.getByText('Longitud del ATR')).toBeVisible();

  await form.getByRole('button', { name: 'Crear bot' }).click();
  await expect(form).toBeHidden();
  expect(state.created.params).toMatchObject({ targetDelta: 0.95, expiryDays: 2, expiryMinDays: 1, expiryMaxDays: 3, takeProfitMode: 'atr_band', capitalUsdt: 10, quantity: 1 });
}

test.describe('Editor de bots · escritorio', () => {
  test.use({ viewport: { width: 1400, height: 900 } });
  test('Simple / Presets / Avanzado y pulsar fuera no cierra', async ({ page }) => { await run(page, 'bot-editor-desktop'); });
});

test.describe('Editor de bots · móvil', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('Simple / Presets / Avanzado y pulsar fuera no cierra', async ({ page }) => { await run(page, 'bot-editor-mobile'); });
});

const { test, expect } = require('@playwright/test');

// Operaciones cerradas · desplegable con el máximo y el mínimo de la prima
// (bid al comprar), cuándo se alcanzó cada uno y el objetivo de TP. /api mockeada.

const MIN = 60_000;
const OPEN = Date.UTC(2026, 9, 28, 4, 1);
const BOT = {
  id: 7, name: 'Bot rango', template: 'alert_signal', mode: 'shadow', status: 'Sin posición', underlying: 'BTC',
  limits: {}, alerts: [], params: { alertIds: [], takeProfitMode: 'atr_band' }, pnl30d: { shadow: 0, live: null }, lastSignal: null,
};
const CLOSED = [
  { id: 1, mode: 'shadow', symbol: 'BTC-261030-81500-P', side: 'BUY', quantity: 0.1, entryPrice: 765, exitPrice: 1025,
    pnlUsdt: 27.46, closeReason: 'take_profit_atr_band', openedAt: OPEN, closedAt: OPEN + 71 * MIN,
    tpTargetPrice: 1025, tpTargetMeta: { spot: 81900, bandValue: 80800, distancePct: -1.3, leverage: 26, appliedGainPct: 34, capped: false },
    premiumRange: { high: { price: 1025, at: OPEN + 71 * MIN }, low: { price: 612, at: OPEN + 12 * MIN }, partial: false } },
  { id: 2, mode: 'shadow', symbol: 'BTC-261028-80750-C', side: 'BUY', quantity: 0.1, entryPrice: 650, exitPrice: 402.3948,
    pnlUsdt: -42.59, closeReason: 'expiry', openedAt: OPEN - 3 * 86400e3, closedAt: OPEN - 86400e3,
    premiumRange: { high: { price: 905, at: OPEN - 3 * 86400e3 + 28 * 60 * MIN }, low: { price: 402.3948, at: OPEN - 86400e3 }, partial: true } },
  { id: 3, mode: 'shadow', symbol: 'ETH-261027-2300-P', side: 'BUY', quantity: 1, entryPrice: 15.4, exitPrice: 0,
    pnlUsdt: -104.46, closeReason: 'expiry', openedAt: OPEN - 4 * 86400e3, closedAt: OPEN - 2 * 86400e3, premiumRange: null },
];

async function mockApi(page) {
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({ id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser' }));
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    if (pathname === '/api/options/underlyings') return json([{ underlying: 'BTC', spot: 80000, change24hPct: 1 }]);
    if (pathname === '/api/options/auto-bots') return json([BOT]);
    if (pathname === '/api/options/strategies/7') {
      return json({ ...BOT, alerts: undefined, kpis: { shadow: { pnl30dUsdt: 0, cycles: 3, winRatePct: 33 }, live: {} },
        usage: {}, events: [], positions: [], closedPositions: CLOSED });
    }
    return json([]);
  });
}

async function horizontalOverflow(page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

test.describe('Operaciones cerradas · rango de la prima (escritorio)', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('el desplegable muestra máximo y mínimo con el tiempo desde la compra', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/opciones?tab=auto');
    await page.getByRole('button', { name: /Bot rango/ }).first().click();
    const detail = page.getByRole('region', { name: 'Detalle del bot' });
    const toggle = detail.getByRole('button', { name: /máximo y mínimo de la prima de BTC-261030-81500-P/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(detail.getByText('a 1 h 11 min de la compra')).toBeVisible();
    await expect(detail.getByText('a 12 min de la compra')).toBeVisible();
    await expect(detail.getByText('Objetivo 1.025,00 (+34,0 %)')).toBeVisible();
    await expect(detail.getByText('Alcanzado')).toBeVisible();
    await detail.getByRole('button', { name: /prima de BTC-261028-80750-C/ }).click();
    await expect(detail.getByText('a 1 día 4 h de la compra')).toBeVisible();
    await expect(detail.getByText(/Aproximado: la operación se abrió antes/)).toBeVisible();
    await detail.getByRole('button', { name: /prima de ETH-261027-2300-P/ }).click();
    await expect(detail.getByText(/Sin registro de la prima/)).toBeVisible();
    await expect(detail.getByText('Sin objetivo de TP registrado.').first()).toBeVisible();
    await detail.getByText('Operaciones cerradas').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/options-premium-range-desktop.png', fullPage: true });
    expect(await horizontalOverflow(page)).toBe(0);
    expect(errores).toEqual([]);
  });
});

test.describe('Operaciones cerradas · rango de la prima (móvil 390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('la tarjeta se despliega con un toque de 44 px', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/opciones?tab=auto');
    await page.getByRole('button', { name: /Bot rango/ }).first().click();
    const detail = page.getByRole('dialog', { name: 'Bot rango' });
    const toggle = detail.getByRole('button', { name: /BTC-261030-81500-P/ });
    await toggle.scrollIntoViewIfNeeded();
    expect((await toggle.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(detail.getByText('a 1 h 11 min de la compra')).toBeVisible();
    await expect(detail.getByText('Objetivo 1.025,00 (+34,0 %)')).toBeVisible();
    await detail.getByText('Objetivo 1.025,00 (+34,0 %)').scrollIntoViewIfNeeded();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/options-premium-range-mobile.png' });
    expect(errores).toEqual([]);
  });
});

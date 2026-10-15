const { test, expect } = require('@playwright/test');

// Módulo de Opciones (Binance European Options): pestañas Trading manual,
// Estrategias y Backtesting en escritorio y en móvil, con /api mockeada.
// Spec: docs/superpowers/specs/2026-10-14-options-module-design.md

const SPOT = 68000;
const EXPIRY = '261031';

function leg(strike, type) {
  const otm = type === 'C' ? Math.max(strike - SPOT, 0) : Math.max(SPOT - strike, 0);
  const mark = Math.max(1200 - otm * 0.25, 40);
  return {
    symbol: `BTC-${EXPIRY}-${strike}-${type}`,
    bid: Math.round(mark * 0.985),
    ask: Math.round(mark * 1.015),
    mark,
    iv: 0.5,
    delta: type === 'C' ? 0.5 - (strike - SPOT) / 20000 : -0.5 - (strike - SPOT) / 20000,
    gamma: 0.0001,
    theta: -40,
    vega: 30,
    openInterest: 50,
  };
}

function chain() {
  const rows = [];
  for (let k = SPOT - 4000; k <= SPOT + 4000; k += 1000) rows.push({ strike: k, call: leg(k, 'C'), put: leg(k, 'P') });
  return {
    underlying: 'BTC',
    spot: SPOT,
    expiries: [{ code: EXPIRY, label: '31 oct', dte: 17 }],
    expiry: EXPIRY,
    rows,
  };
}

async function mockApi(page) {
  const orders = [];
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const json = (data, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });

    if (pathname === '/api/options/underlyings') return json([{ underlying: 'BTC', spot: SPOT, change24hPct: 1.84 }, { underlying: 'ETH', spot: 2450, change24hPct: -0.5 }]);
    if (pathname === '/api/options/chain') return json(chain());
    if (pathname === '/api/options/account') return json({ balanceUsdt: 5000, marginUsedUsdt: 1240, unrealizedPnlUsdt: 126.35, greeks: { delta: 0.214, gamma: 0.003, theta: -18.4, vega: 42.1 } });
    if (pathname === '/api/options/positions') return json([]);
    if (pathname === '/api/options/orders/open') return json([]);
    if (pathname === '/api/options/trades') return json([]);
    if (pathname === '/api/options/orders' && method === 'POST') {
      orders.push(route.request().postDataJSON());
      return json({ orderId: '1', status: 'ACCEPTED' });
    }
    if (pathname === '/api/settings/binance-options') return json({ configured: true, alias: 'Principal', apiKeyMasked: 'abcd***' });
    if (pathname === '/api/options/strategies/templates') {
      return json([{ id: 'short_strangle', label: 'Strangle corto', defaultParams: { quantity: 0.1 }, paramSchema: [{ key: 'quantity', label: 'Cantidad por pata', type: 'number', min: 0.0001, max: 1000, step: 0.01 }] }]);
    }
    if (pathname === '/api/options/strategies') return json([]);
    if (pathname === '/api/options/backtests') return json([]);
    // Fallback en array: varios consumidores globales hacen `.reduce`.
    return json([]);
  });
  return { orders };
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

test.describe('Opciones en escritorio', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('cadena → ticket → orden confirmada, y las tres pestañas cargan', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    const { orders } = await mockApi(page);
    await page.goto('/opciones');

    const cadena = page.getByRole('region', { name: 'Cadena de opciones' });
    await expect(cadena).toBeVisible();
    await cadena.getByRole('button', { name: /Comprar call 70\.000/ }).click();
    const ticket = page.getByRole('complementary', { name: 'Ticket de orden' });
    await expect(ticket).toContainText(`BTC-${EXPIRY}-70000-C`);
    await page.screenshot({ path: 'test-results/options-desktop-manual.png' });

    await ticket.getByRole('button', { name: /Comprar call/ }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: /Confirmar|Enviar|Comprar/ }).last().click();
    await expect.poll(() => orders.length).toBe(1);
    expect(orders[0]).toMatchObject({ symbol: `BTC-${EXPIRY}-70000-C`, side: 'BUY' });

    const nav = page.getByRole('navigation', { name: 'Secciones de opciones' });
    await nav.getByRole('link', { name: /Estrategias/ }).click();
    await expect(page.getByRole('button', { name: 'Nueva estrategia' })).toBeVisible();
    await nav.getByRole('link', { name: /Backtesting/ }).click();
    await expect(page.getByRole('button', { name: /Ejecutar backtest/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/options-desktop-backtesting.png' });

    expect(await horizontalOverflow(page)).toBe(0);
    expect(errores).toEqual([]);
  });
});

test.describe('Opciones en móvil (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('fila de la cadena abre el ticket en hoja inferior y no hay scroll horizontal', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/opciones');

    await page.getByRole('button', { name: /^Call 70\.000/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva orden' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(`BTC-${EXPIRY}-70000-C`);
    expect(await horizontalOverflow(page)).toBe(0);
    // La hoja entra con una animación: la captura espera a que termine.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.screenshot({ path: 'test-results/options-mobile-ticket.png' });
    await sheet.getByRole('button', { name: 'Cerrar' }).last().click();

    for (const [tab, check] of [
      ['Estrategias', page.getByRole('button', { name: /Nueva/ }).first()],
      ['Backtest', page.getByRole('button', { name: /Ejecutar backtest/ })],
    ]) {
      await page.getByRole('navigation', { name: 'Secciones de opciones' }).getByRole('link', { name: new RegExp(tab) }).click();
      await expect(check).toBeVisible();
      expect(await horizontalOverflow(page)).toBe(0);
    }
    await page.screenshot({ path: 'test-results/options-mobile-backtesting.png' });
    expect(errores).toEqual([]);
  });
});

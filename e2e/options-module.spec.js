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

// Trading automatizado: un bot BTC con dos alertas y su registro de señales.
// Spec: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md
const ALERT_UP = { id: 11, name: 'BTC · MACD cruce alcista 15m', direction: 'bullish', assetList: ['BTCUSDT'], thresholdPercent: 70 };
const ALERT_DOWN = { id: 12, name: 'BTC · MACD cruce bajista 15m', direction: 'bearish', assetList: ['BTCUSDT'], thresholdPercent: 70 };
const BOT = {
  id: 7,
  name: 'Momentum BTC (MACD 15m)',
  template: 'alert_signal',
  underlying: 'BTC',
  mode: 'shadow',
  status: 'Call abierta',
  params: { alertIds: [11, 12], structure: 'buy_with', targetDelta: 0.35, expiryDays: 7, quantity: 0.05, onOpposite: 'reverse', takeProfitPct: 80, stopLossPct: 50, exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4, maxPremiumUsdt: 150 },
  limits: {},
  alerts: [ALERT_UP, ALERT_DOWN],
  pnl30d: { shadow: 214.6, live: null },
  lastSignal: { alertName: ALERT_UP.name, direction: 'bullish', asset: 'BTCUSDT', decision: 'opened', detail: 'Compra BTC-261024-70000-C a 905', createdAt: Date.now() - 60000 },
};
const BOT_SIGNALS = [
  { id: 1, alertId: 11, alertName: ALERT_UP.name, direction: 'bullish', asset: 'BTCUSDT', score: 85, decision: 'opened', detail: 'Compra BTC-261024-70000-C a 905 · 0,05', createdAt: Date.now() - 60000 },
  { id: 2, alertId: 12, alertName: ALERT_DOWN.name, direction: 'bearish', asset: 'BTCUSDT', score: 72, decision: 'ignored', detail: 'Ya hay una posición abierta (máx. 1)', createdAt: Date.now() - 3600000 },
];

async function mockApi(page) {
  const orders = [];
  const botRequests = [];
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
    if (pathname === '/api/options/auto-bots/eligible-alerts') return json([ALERT_UP, ALERT_DOWN]);
    if (/^\/api\/options\/auto-bots\/\d+\/signals$/.test(pathname)) return json(BOT_SIGNALS);
    if (pathname === '/api/options/auto-bots' && method === 'POST') {
      botRequests.push(route.request().postDataJSON());
      return json({ ...BOT, id: 8, name: 'Nuevo' });
    }
    if (pathname === '/api/options/auto-bots') return json([BOT]);
    if (pathname === `/api/options/strategies/${BOT.id}`) {
      return json({ ...BOT, alerts: undefined, kpis: { shadow: { pnl30dUsdt: 214.6, cycles: 9, winRatePct: 66.7 }, live: {} }, usage: {}, events: [] });
    }
    if (pathname === '/api/options/backtests') return json([]);
    // Fallback en array: varios consumidores globales hacen `.reduce`.
    return json([]);
  });
  return { orders, botRequests };
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

  test('la cantidad se escribe en USD de prima y se envía en contratos válidos', async ({ page }) => {
    const { orders } = await mockApi(page);
    await page.goto('/opciones');
    await page.getByRole('region', { name: 'Cadena de opciones' }).getByRole('button', { name: /Comprar call 70\.000/ }).click();
    const ticket = page.getByRole('complementary', { name: 'Ticket de orden' });
    await expect(ticket.getByRole('button', { name: 'USD', pressed: true })).toBeVisible();

    const ask = leg(70000, 'C').ask;
    const contracts = Math.round((250 * 100) / ask) / 100;
    await ticket.getByLabel('Cantidad (USD)').fill('250');
    await expect(ticket).toContainText(`≈ ${contracts.toFixed(2).replace('.', ',')} contratos`);
    await ticket.screenshot({ path: 'test-results/options-desktop-ticket-usd.png' });

    await ticket.getByRole('button', { name: /Comprar call/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Confirmar|Enviar|Comprar/ }).last().click();
    await expect.poll(() => orders.length).toBe(1);
    expect(orders[0]).toMatchObject({ symbol: `BTC-${EXPIRY}-70000-C`, side: 'BUY', quantity: contracts, price: ask });
  });

  test('Trading automatizado: bot, señales y formulario «Nuevo bot»', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/opciones?tab=auto');

    const nav = page.getByRole('navigation', { name: 'Secciones de opciones' });
    await expect(nav.getByRole('link', { name: /Trading automatizado/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: BOT.name })).toBeVisible();
    const mapping = page.getByRole('list', { name: 'Qué abre cada dirección' });
    await expect(mapping).toContainText('Comprar call');
    await expect(mapping).toContainText('Comprar put');
    await expect(page.getByText('Ya hay una posición abierta (máx. 1)')).toBeVisible();
    await page.getByRole('group', { name: 'Filtrar señales' }).getByRole('button', { name: 'Operadas' }).click();
    await expect(page.getByRole('group', { name: 'Filtrar señales' }).getByRole('button', { name: 'Operadas' })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: 'test-results/options-desktop-auto.png' });

    await page.getByRole('button', { name: 'Nuevo bot' }).click();
    const form = page.getByRole('dialog', { name: 'Nuevo bot' });
    await expect(form.getByRole('checkbox', { name: new RegExp(ALERT_UP.name) })).toBeVisible();
    await form.getByRole('radio', { name: /Vender en contra/ }).click();
    await expect(form.getByRole('list', { name: 'Qué abre cada dirección' })).toContainText('Vender put');
    await form.getByRole('button', { name: 'Cancelar' }).click();

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
    // Cantidad en USD por defecto, con el cálculo aproximado en contratos.
    await expect(sheet.getByRole('button', { name: 'USD', pressed: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Más USD' }).click();
    await expect(sheet.getByLabel('Prima (USD)')).toHaveValue('110');
    await expect(sheet).toContainText(/≈ \d+,\d{2} contratos · prima/);
    await sheet.getByRole('button', { name: 'Contratos' }).click();
    await expect(sheet.getByLabel('Contratos', { exact: true })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/options-mobile-ticket-units.png' });
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

  test('Trading automatizado: «Última señal», tarjetas, FAB y detalle a pantalla completa', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/opciones');
    await page.getByRole('navigation', { name: 'Secciones de opciones' }).getByRole('link', { name: 'Auto' }).click();

    await expect(page.getByRole('button', { name: /Última señal/ })).toContainText('Alcista · BTC');
    await expect(page.getByRole('button', { name: 'Nuevo bot' })).toBeVisible();
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await horizontalOverflow(page)).toBe(0);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/options-mobile-auto.png' });

    await page.getByRole('list', { name: 'Bots' }).getByRole('button', { name: new RegExp(BOT.name.replace(/[()]/g, '\\$&')) }).click();
    const detail = page.getByRole('dialog', { name: BOT.name });
    await expect(detail).toBeVisible();
    await expect(detail.getByText('Al recibir la señal')).toBeVisible();
    await expect(detail.getByRole('list', { name: 'Señales' })).toContainText('Ignorada');
    expect(await horizontalOverflow(page)).toBe(0);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.screenshot({ path: 'test-results/options-mobile-auto-detail.png' });
    await detail.getByRole('button', { name: 'Volver' }).click();
    await expect(detail).toBeHidden();
    expect(errores).toEqual([]);
  });
});

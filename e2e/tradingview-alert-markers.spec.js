const { test, expect } = require('@playwright/test');

// Marcas de backtest de alertas en TradingView: selector, chips con contador,
// tarjeta de detalle al pasar sobre la vela, ojo, cambio de temporalidad,
// móvil (pestaña «Alertas» + hoja con ‹ ›) y Multi‑TF.
// La API se simula entera con page.route. El gráfico es un canvas: las marcas
// se comprueban pasando el ratón (o tocando) por velas con disparo, que el
// mock sitúa en todas las velas de 5m de los últimos dos días.

const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};
const DAY = 86_400_000;
const ALERT_ID = 7;
const ALERT_NAME = 'RSI sobreventa ETH';
const ALERT = {
  id: ALERT_ID,
  name: ALERT_NAME,
  asset: 'ETH',
  datasource: 'hyperliquid',
  direction: 'bullish',
  thresholdPercent: 70,
  cooldownSeconds: 900,
  isActive: true,
  updatedAt: '2026-10-20T00:00:00.000Z',
  rules: [{ indicatorType: 'RSI', timeframe: '5m', weight: 1, params: { period: 14 }, condition: 'below', value: 30 }],
};
const OTHER_ALERT = {
  ...ALERT,
  id: 8,
  name: 'EMA cruce BTC',
  direction: 'bearish',
  rules: [{ indicatorType: 'EMA', timeframe: '1h', weight: 1 }],
};

function series(tf, { startTime, endTime, limit }, base) {
  const step = TF_MS[tf] || TF_MS['15m'];
  const end = Math.floor((endTime || Date.now()) / step) * step;
  let from = startTime ? Math.ceil(startTime / step) * step : end - (limit - 1) * step;
  if ((end - from) / step + 1 > 1000) from = end - 999 * step;
  const out = [];
  let price = base;
  for (let t = from, i = 0; t <= end; t += step, i++) {
    const open = price;
    const close = open + Math.sin(i / 5) * base * 0.003 + (i % 3 === 0 ? -1 : 1.3);
    price = close;
    out.push({
      time: t, closeTime: t + step, open,
      high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 + i,
    });
  }
  return out;
}

// Respuesta del backtest: un disparo en cada boundary de 5m de los últimos
// dos días dentro de [startTime, endTime]; uno de cada tres, suprimido.
function backtest({ startTime, endTime }) {
  const base = TF_MS['5m'];
  const now = Date.now();
  const to = Math.min(endTime, now - 3000);
  const from = Math.max(startTime, now - 2 * DAY);
  const events = [];
  for (let b = Math.floor(from / base) * base + base; b <= to; b += base) {
    events.push({
      time: b,
      evalTime: b,
      score: 80,
      threshold: 70,
      suppressed: (b / base) % 3 === 0,
      rules: [{
        indicatorType: 'RSI', timeframe: '5m',
        conditions: [{ indicatorType: 'RSI', timeframe: '5m' }],
        weight: 1, matched: true, reason: 'RSI 24.1 < 30',
      }],
    });
  }
  return {
    alertId: ALERT_ID, alertUpdatedAt: ALERT.updatedAt, asset: 'ETH', datasource: 'hyperliquid',
    alertDatasource: 'hyperliquid', baseTimeframe: '5m', from: startTime, to,
    events, insufficient: 0, cooldownApprox: false,
  };
}

async function mockApi(page, { selected = [] } = {}) {
  const state = { items: selected, backtests: [] };
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
    localStorage.removeItem('tv_overlays_v1');
    localStorage.removeItem('tv_multi_prefs_v1');
    localStorage.removeItem('tv_multi_mode_v1');
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const q = url.searchParams;
    const json = (data) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
    const { pathname } = url;
    if (pathname === '/api/market/candles') {
      return json(series(q.get('timeframe') || '15m', {
        startTime: Number(q.get('startTime')) || 0,
        endTime: Number(q.get('endTime')) || 0,
        limit: Number(q.get('limit') || 300),
      }, 2300));
    }
    if (pathname === '/api/market/catalog') {
      return json({
        categories: { crypto: 'Cripto' },
        assets: [{ id: 'hl-ETH', symbol: 'ETH', datasource: 'hyperliquid', name: 'ETH', category: 'crypto' }],
      });
    }
    if (pathname === '/api/alerts') return json([ALERT, OTHER_ALERT]);
    const bt = pathname.match(/^\/api\/alerts\/(\d+)\/backtest$/);
    if (bt && req.method() === 'POST') {
      const body = req.postDataJSON() || {};
      state.backtests.push({ id: Number(bt[1]), ...body });
      return json(backtest(body));
    }
    if (pathname === '/api/settings/chart-alert-markers') {
      if (req.method() === 'PUT') state.items = (req.postDataJSON() || {}).items || [];
      return json({ items: state.items });
    }
    if (pathname === '/api/settings/chart-indicators') return json({ indicators: [] });
    return json([]);
  });
  return state;
}

const card = (scope) => scope.getByRole('dialog', { name: 'Detalle del disparo' });

// Recorre el canvas de derecha a izquierda hasta que aparece la tarjeta
// (la vela bajo el puntero tiene disparo). Devuelve la posición o null.
async function hoverUntilCard(page, canvas, scope = page) {
  const box = await canvas.boundingBox();
  const y = box.y + box.height * 0.5;
  for (let f = 0.9; f >= 0.4; f -= 0.02) {
    const x = box.x + box.width * f;
    await page.mouse.move(x, y);
    try {
      await expect(card(scope)).toBeVisible({ timeout: 300 });
      return { x, y };
    } catch { /* sin disparo en esta vela */ }
  }
  return null;
}

async function noCardAnywhere(page, canvas) {
  const box = await canvas.boundingBox();
  const y = box.y + box.height * 0.5;
  for (let f = 0.9; f >= 0.4; f -= 0.05) {
    await page.mouse.move(box.x + box.width * f, y);
    await page.waitForTimeout(80);
    if (await card(page).isVisible()) return false;
  }
  return true;
}

const chips = (page) => page.getByRole('toolbar', { name: 'Alertas en el gráfico' });

test.describe('TradingView marcas de alertas (escritorio 1440×900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('elegir alerta → chip con contador, tarjeta con «Puntuación», ojo y cambio a 1h', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    const state = await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    await page.getByRole('button', { name: /^Alertas/ }).click();
    const picker = page.getByRole('dialog', { name: 'Alertas en el gráfico' });
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('0 de 6');
    await picker.getByRole('checkbox', { name: ALERT_NAME }).check();
    await expect(picker).toContainText('1 de 6');
    await picker.getByRole('button', { name: 'Cerrar' }).click();
    await expect(picker).toHaveCount(0);

    // Chip con contador de disparos no suprimidos (> 0) y selección guardada.
    await expect(chips(page)).toBeVisible();
    await expect(chips(page)).toContainText(ALERT_NAME);
    const count = chips(page).getByTitle('Disparos en el rango');
    await expect(count).toHaveText(/^[1-9]\d*$/);
    expect(state.items).toEqual([expect.objectContaining({ alertId: ALERT_ID, hidden: false })]);
    expect(state.backtests.length).toBeGreaterThan(0);
    expect(state.backtests[0]).toMatchObject({ id: ALERT_ID, asset: 'ETH', datasource: 'hyperliquid' });
    await expect(page.getByRole('button', { name: /^Alertas/ })).toContainText('1/6');

    // Pasar sobre una vela con disparo muestra la tarjeta.
    const hit = await hoverUntilCard(page, canvas);
    expect(hit, 'alguna vela con disparo muestra la tarjeta').not.toBeNull();
    await expect(card(page)).toContainText('Puntuación 80% (umbral 70%)');
    await expect(card(page)).toContainText(ALERT_NAME);
    await expect(card(page)).toContainText('RSI 5m');
    await page.screenshot({ path: 'test-results/tv-alert-markers-desktop.png' });

    // El ojo oculta las marcas: ninguna vela muestra tarjeta.
    await page.mouse.move(5, 5);
    await chips(page).getByRole('button', { name: `Ocultar ${ALERT_NAME}` }).click();
    await expect(chips(page).getByRole('button', { name: `Mostrar ${ALERT_NAME}` })).toBeVisible();
    expect(await noCardAnywhere(page, canvas)).toBe(true);
    await page.mouse.move(5, 5);
    await chips(page).getByRole('button', { name: `Mostrar ${ALERT_NAME}` }).click();
    await expect(chips(page).getByRole('button', { name: `Ocultar ${ALERT_NAME}` })).toBeVisible();

    // En 1h la marca sigue ahí (agrupada en la vela de 1h).
    await page.mouse.move(5, 5);
    await page.getByRole('button', { name: '1h', exact: true }).first().click();
    await expect(page.getByRole('button', { name: '1h', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
    await expect(count).toHaveText(/^[1-9]\d*$/);
    const hit1h = await hoverUntilCard(page, canvas);
    expect(hit1h, 'en 1h alguna vela con disparo muestra la tarjeta').not.toBeNull();
    await expect(card(page).first()).toContainText('Puntuación');

    // Un clic la fija y Esc la cierra.
    await page.mouse.click(hit1h.x, hit1h.y);
    await expect(card(page).getByRole('button', { name: 'Cerrar' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    expect(errores).toEqual([]);
  });
});

test.describe('TradingView marcas de alertas (móvil 360×740)', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  test('pestaña «Alertas», selección, toque en la vela y hoja con «siguiente ›»', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    const tabs = page.getByRole('navigation', { name: 'Herramientas del gráfico' });
    await expect(tabs.getByRole('button', { name: 'Alertas' })).toBeVisible();

    await tabs.getByRole('button', { name: 'Alertas' }).click();
    const sheet = page.getByRole('dialog', { name: 'Alertas en el gráfico' });
    await expect(sheet).toBeVisible();
    const row = sheet.getByRole('checkbox', { name: ALERT_NAME });
    await row.check();
    await expect(sheet).toContainText('1 de 6');
    // Fila táctil de 44 px.
    const label = sheet.locator('label').filter({ has: page.getByRole('checkbox', { name: ALERT_NAME }) });
    expect((await label.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');
    if (await sheet.isVisible()) await sheet.getByRole('button', { name: 'Cerrar' }).first().click({ force: true });
    await expect(sheet).toHaveCount(0);

    await expect(tabs.getByRole('button', { name: 'Alertas, 1 en el gráfico' })).toBeVisible();
    const pill = page.getByRole('group', { name: 'Alertas en el gráfico' }).getByRole('button', { name: ALERT_NAME });
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/[1-9]\d*/);
    expect((await pill.boundingBox()).height).toBeGreaterThanOrEqual(44);

    // Toque en una vela con disparo: hoja «Disparo de alerta» con ‹ anterior / siguiente ›.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    const fireSheet = page.getByRole('dialog', { name: 'Disparo de alerta' });
    let opened = false;
    for (let f = 0.5; f <= 0.8 && !opened; f += 0.05) {
      await page.touchscreen.tap(box.x + box.width * f, box.y + box.height * 0.5);
      opened = await fireSheet.waitFor({ state: 'visible', timeout: 500 }).then(() => true, () => false);
    }
    expect(opened, 'tocar una vela con disparo abre la hoja').toBe(true);
    await expect(fireSheet).toContainText('Puntuación 80% (umbral 70%)');
    const next = fireSheet.getByRole('button', { name: 'siguiente ›' });
    await expect(next).toBeVisible();
    await expect(next).toBeEnabled();
    const pos = fireSheet.getByText(/^\d+ \/ \d+$/);
    const before = await pos.textContent();
    await next.click();
    await expect(pos).not.toHaveText(before);
    await expect(fireSheet.getByRole('button', { name: '‹ anterior' })).toBeEnabled();
    await page.screenshot({ path: 'test-results/tv-alert-markers-mobile.png' });

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    expect(errores).toEqual([]);
  });
});

test.describe('TradingView marcas de alertas (Multi‑TF)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('los dos primeros paneles muestran la marca', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    const state = await mockApi(page, { selected: [{ alertId: ALERT_ID, color: '#facc15', hidden: false }] });
    await page.goto('/trading-view/multi?symbol=ETH&datasource=hyperliquid');

    for (const i of [0, 1]) await expect(page.getByTestId(`synced-chart-${i}`).locator('canvas').first()).toBeVisible();
    await expect(chips(page)).toContainText(ALERT_NAME);
    await expect(chips(page).getByTitle('Disparos en el rango')).toHaveText(/^[1-9]\d*$/);
    await expect.poll(() => state.backtests.length).toBeGreaterThan(0);

    for (const i of [0, 1]) {
      const panel = page.getByTestId(`synced-chart-${i}`);
      await page.mouse.move(5, 5);
      const hit = await hoverUntilCard(page, panel.locator('canvas').first(), panel);
      expect(hit, `panel ${i}: alguna vela con disparo muestra la tarjeta`).not.toBeNull();
      await expect(card(panel)).toContainText('Puntuación');
    }
    await page.screenshot({ path: 'test-results/tv-alert-markers-multi.png' });
    expect(errores).toEqual([]);
  });
});

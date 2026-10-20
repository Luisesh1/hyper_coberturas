const { test, expect } = require('@playwright/test');

// Vista multi-temporalidad: varios gráficos del mismo activo con el puntero
// sincronizado. Verde = la vela del otro gráfico abre en el mismo instante;
// amarillo oscuro = el instante cae dentro de una vela más larga.

const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};

function buildCandles(tf, limit) {
  const step = TF_MS[tf] || TF_MS['15m'];
  const end = Math.floor(Date.now() / step) * step;
  let price = 2300;
  return Array.from({ length: limit }, (_, i) => {
    const time = end - (limit - 1 - i) * step;
    const open = price;
    const close = open + Math.sin(i / 5) * 6 + (i % 3 === 0 ? -3 : 4);
    price = close;
    return {
      time,
      closeTime: time + step,
      open,
      high: Math.max(open, close) + 3,
      low: Math.min(open, close) - 3,
      close,
      volume: 1000 + i,
    };
  });
}

async function mockApi(page) {
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
    localStorage.removeItem('tv_multi_prefs_v1');
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
    if (url.pathname === '/api/market/candles') {
      if (url.searchParams.get('endTime')) return json([]);
      const tf = url.searchParams.get('timeframe') || '15m';
      const limit = Number(url.searchParams.get('limit') || 300);
      return json(buildCandles(tf, Math.min(limit, 500)));
    }
    if (url.pathname === '/api/settings/chart-indicators') return json({ indicators: [] });
    return json([]);
  });
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

test.describe('TradingView multi-temporalidad (escritorio)', () => {
  test('2×2 por defecto, cambio a 1×3 y colores del puntero sincronizado', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view/multi?symbol=ETH&datasource=hyperliquid');

    for (const i of [0, 1, 2, 3]) await expect(page.getByTestId(`synced-chart-${i}`)).toBeVisible();
    await expect(page.getByRole('button', { name: /2×2/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="synced-chart-0"] canvas').first()).toBeVisible();

    // Recorre el gráfico de 15m (panel 1) desde la derecha. Con origen 15m:
    // el 5m (panel 0) nunca puede quedar "near" (toda apertura de 15m es
    // apertura de 5m) y el 1h (panel 2) debe verse "exact" en las velas en
    // punto y "near" en :15/:30/:45.
    const box = await page.getByTestId('synced-chart-1').boundingBox();
    const y = box.y + box.height * 0.5;
    const seen1h = new Set();
    for (let k = 0; k < 24 && seen1h.size < 2; k++) {
      await page.mouse.move(box.x + box.width * 0.86 - k * 9, y);
      await page.waitForTimeout(60);
      await expect(page.getByTestId('sync-chip-1')).toHaveAttribute('data-status', 'source');
      const s0 = await page.getByTestId('sync-chip-0').getAttribute('data-status');
      expect(['exact', 'out']).toContain(s0);
      const s2 = await page.getByTestId('sync-chip-2').getAttribute('data-status');
      if (s2 === 'exact' || s2 === 'near') seen1h.add(s2);
    }
    expect([...seen1h].sort()).toEqual(['exact', 'near']);
    await page.screenshot({ path: 'test-results/tv-multi-desktop.png' });

    // Al salir del gráfico se limpia el puntero en todos.
    await page.mouse.move(box.x + box.width / 2, 5);
    await expect(page.getByTestId('sync-chip-2')).toHaveCount(0);

    await page.getByRole('button', { name: /1×3/ }).click();
    await expect(page.getByTestId('synced-chart-2')).toBeVisible();
    await expect(page.getByTestId('synced-chart-3')).toHaveCount(0);
    expect(errores).toEqual([]);
  });
});

test.describe('TradingView multi-temporalidad (móvil 390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('tres gráficos apilados sin scroll horizontal', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view/multi?symbol=ETH&datasource=hyperliquid');

    for (const i of [0, 1, 2]) await expect(page.getByTestId(`synced-chart-${i}`)).toBeVisible();
    await expect(page.getByTestId('synced-chart-3')).toHaveCount(0);
    const a = await page.getByTestId('synced-chart-0').boundingBox();
    const b = await page.getByTestId('synced-chart-1').boundingBox();
    expect(b.y).toBeGreaterThan(a.y + a.height - 2);
    expect(a.height).toBeGreaterThan(150);
    await expect(page.getByText('Mantén pulsado y arrastra sobre un gráfico')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/tv-multi-mobile.png' });
    expect(errores).toEqual([]);
  });
});

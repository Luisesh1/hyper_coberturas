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
    localStorage.removeItem('tv_split_prefs_v1');
    localStorage.removeItem('tv_multi_mode_v1');
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
      // Serie completa y estable: el polling (limit=2) recibe las mismas
      // últimas velas que la carga inicial.
      return json(buildCandles(tf, 500).slice(-Math.min(limit, 500)));
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
    const y = box.y + box.height * 0.35; // panel de precio, sobre el sub-panel del oscilador
    const seen1h = new Set();
    for (let k = 0; k < 24 && seen1h.size < 2; k++) {
      // Arranca a la izquierda del margen derecho vacío (rightOffset).
      await page.mouse.move(box.x + box.width * 0.6 - k * 9, y);
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

test.describe('TradingView multi-temporalidad · scroll infinito', () => {
  test('al arrastrar hasta el borde izquierdo carga velas anteriores y sigue más atrás', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    // Histórico: 500 velas que acaban justo antes de `endTime`.
    const historyEnds = [];
    await page.route((url) => url.pathname === '/api/market/candles' && url.searchParams.has('endTime'), (route) => {
      const url = new URL(route.request().url());
      const tf = url.searchParams.get('timeframe');
      const step = TF_MS[tf];
      const endTime = Number(url.searchParams.get('endTime'));
      historyEnds.push({ tf, endTime });
      const last = Math.floor(endTime / step) * step;
      const data = buildCandles(tf, 500).map((c, i) => {
        const time = last - (499 - i) * step;
        return { ...c, time, closeTime: time + step };
      });
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }),
      });
    });
    await page.goto('/trading-view/multi?symbol=ETH&datasource=hyperliquid');
    await expect(page.locator('[data-testid="synced-chart-1"] canvas').first()).toBeVisible();
    await page.waitForTimeout(300);

    const box = await page.getByTestId('synced-chart-1').boundingBox();
    const y = box.y + box.height * 0.35;
    const drag = async () => {
      await page.mouse.move(box.x + box.width * 0.1, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.9, y, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(80);
    };
    const panel15 = () => historyEnds.filter((h) => h.tf === '15m');
    for (let k = 0; k < 60 && panel15().length < 2; k++) await drag();

    const reqs = panel15();
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    // La primera pide justo antes de la vela más antigua de la carga inicial;
    // la segunda, 500 velas de 15m antes.
    expect(reqs[0].endTime - reqs[1].endTime).toBe(500 * TF_MS['15m']);
    // Los demás paneles no se tocan.
    expect(historyEnds.filter((h) => h.tf !== '15m')).toEqual([]);
    await page.screenshot({ path: 'test-results/tv-multi-history.png' });
    expect(errores).toEqual([]);
  });
});

test.describe('TradingView multi-temporalidad (móvil 390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('solo 1×2: dos gráficos apilados sin scroll horizontal', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view/multi?symbol=ETH&datasource=hyperliquid');

    for (const i of [0, 1]) await expect(page.getByTestId(`synced-chart-${i}`)).toBeVisible();
    await expect(page.getByTestId('synced-chart-2')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Distribución' })).toHaveCount(0);
    const a = await page.getByTestId('synced-chart-0').boundingBox();
    const b = await page.getByTestId('synced-chart-1').boundingBox();
    expect(b.y).toBeGreaterThan(a.y + a.height - 2);
    expect(a.height).toBeGreaterThan(150);
    await expect(page.getByText('Mantén pulsado y arrastra sobre un gráfico')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/tv-multi-mobile.png' });
    expect(errores).toEqual([]);
  });

  test('pantalla completa cubre la ventana y oculta la cabecera global', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view/multi?symbol=ETH&datasource=hyperliquid');
    await expect(page.getByTestId('synced-chart-1')).toBeVisible();
    await page.getByRole('button', { name: 'Pantalla completa' }).click();
    const exit = page.getByRole('button', { name: 'Salir de pantalla completa' });
    await expect(exit).toBeVisible();
    const box = await page.getByTestId('synced-chart-1').boundingBox();
    expect(box.y + box.height).toBeGreaterThan(600);
    await exit.click();
    await expect(page.getByRole('button', { name: 'Pantalla completa' })).toBeVisible();
  });

  test('táctil: tras mantener pulsado y soltar, el siguiente arrastre desplaza (no deja puntero)', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view/multi?symbol=ETH&datasource=hyperliquid');
    await expect(page.locator('[data-testid="synced-chart-1"] canvas').first()).toBeVisible();
    const box = await page.getByTestId('synced-chart-1').boundingBox();
    const y = box.y + box.height * 0.6;
    const x0 = box.x + box.width * 0.6;

    // Playwright solo ofrece `tap`; el arrastre táctil se envía por CDP.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });

    // 1) Mantener pulsado (> long tap de lightweight-charts) y arrastrar:
    //    el puntero sincronizado aparece con este gráfico como origen.
    await touch('touchStart', x0);
    await page.waitForTimeout(700);
    for (let k = 1; k <= 6; k++) {
      await touch('touchMove', x0 - k * 12);
      await page.waitForTimeout(30);
    }
    await expect(page.getByTestId('sync-chip-1')).toHaveAttribute('data-status', 'source');

    // 2) Al soltar se limpia en todos.
    await touch('touchEnd', x0 - 72);
    await expect(page.locator('[data-testid^="sync-chip-"]')).toHaveCount(0);

    // 3) Un arrastre rápido posterior desplaza el gráfico: con
    //    exitMode=OnNextTap el gráfico seguía en modo seguimiento y este
    //    arrastre movía el puntero (reaparecían los chips).
    await touch('touchStart', x0);
    for (let k = 1; k <= 6; k++) {
      await touch('touchMove', x0 + k * 12);
      await page.waitForTimeout(16);
      await expect(page.locator('[data-testid^="sync-chip-"]')).toHaveCount(0);
    }
    await touch('touchEnd', x0 + 72);
    await expect(page.locator('[data-testid^="sync-chip-"]')).toHaveCount(0);
  });
});

// Pantalla dividida: hasta 4 activos independientes; el puntero compartido
// (apagado por defecto) sincroniza solo el tiempo.
test.describe('TradingView multi-activo (escritorio)', () => {
  test('Multi‑activo: 4 activos independientes y sincronización opcional', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view/multi?mode=assets');

    await expect(page.getByRole('button', { name: /^Multi‑activo$/ })).toHaveAttribute('aria-pressed', 'true');
    const expected = ['BTC', 'ETH', 'SOL', 'HYPE'];
    for (const [i, sym] of expected.entries()) {
      await expect(page.getByTestId(`synced-chart-${i}`)).toBeVisible();
      await expect(page.getByTestId(`asset-btn-${i}`)).toContainText(sym);
    }
    await expect(page.locator('[data-testid="synced-chart-0"] canvas').first()).toBeVisible();
    await expect(page.locator('[data-testid="synced-chart-1"] canvas').first()).toBeVisible();

    const sw = page.getByRole('switch', { name: /Puntero sincronizado/ });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    const box = await page.getByTestId('synced-chart-0').boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35);
    await expect(page.getByTestId('sync-chip-0')).toHaveAttribute('data-status', 'source');
    await expect(page.getByTestId('sync-chip-1')).toHaveAttribute('data-status', /^(exact|near|out)$/);
    await expect(page.getByText(/^Puntero: .+ · BTC 15m$/)).toBeVisible();
    await page.screenshot({ path: 'test-results/tv-split-desktop.png' });
    expect(errores).toEqual([]);
  });
});

test.describe('TradingView multi-activo (móvil 390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Multi‑activo móvil: dos gráficos apilados sin scroll horizontal', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view/multi?mode=assets');

    for (const i of [0, 1]) await expect(page.getByTestId(`synced-chart-${i}`)).toBeVisible();
    await expect(page.getByTestId('synced-chart-2')).toHaveCount(0);
    await expect(page.getByTestId('asset-btn-0')).toContainText('BTC');
    await expect(page.getByTestId('asset-btn-1')).toContainText('ETH');
    const a = await page.getByTestId('synced-chart-0').boundingBox();
    const b = await page.getByTestId('synced-chart-1').boundingBox();
    expect(b.y).toBeGreaterThan(a.y + a.height - 2);
    expect(a.height).toBeGreaterThan(200);

    // Táctil: selector de modo y botones de activo de al menos 44 px.
    for (const name of [/^Multi‑TF$/, /^Multi‑activo$/]) {
      const m = await page.getByRole('button', { name }).boundingBox();
      expect(m.height).toBeGreaterThanOrEqual(44);
    }
    const assetBtn = await page.getByTestId('asset-btn-0').boundingBox();
    expect(assetBtn.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId('multi-price')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/tv-split-mobile.png' });
    expect(errores).toEqual([]);
  });
});

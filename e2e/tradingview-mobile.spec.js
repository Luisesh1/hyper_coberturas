const { test, expect } = require('@playwright/test');

// Rediseño móvil de TradingView: pestañas inferiores, hojas inferiores para
// la configuración, modo dibujo explícito (con deshacer) y replay acoplado.

function buildCandles() {
  const start = Date.now() - (120 * 15 * 60_000);
  let price = 2300;
  return Array.from({ length: 120 }, (_, i) => {
    const open = price;
    const close = open + Math.sin(i / 4) * 6 + (i % 3 === 0 ? -3 : 4);
    price = close;
    const time = start + i * 15 * 60_000;
    return {
      time,
      closeTime: time + 15 * 60_000,
      open,
      high: Math.max(open, close) + 3,
      low: Math.min(open, close) - 3,
      close,
      volume: 1000 + i,
    };
  });
}

async function mockApi(page) {
  const candles = buildCandles();
  const savedDrawings = [];

  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    const method = route.request().method();
    const json = (data) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });

    if (pathname === '/api/market/candles') {
      const limit = Number(url.searchParams.get('limit') || candles.length);
      return json(url.searchParams.get('endTime') ? [] : candles.slice(-limit));
    }
    if (pathname === '/api/settings/chart-indicators') return json({ indicators: [] });
    if (pathname.startsWith('/api/settings/chart-drawings/')) {
      if (method === 'PUT') {
        savedDrawings.push(route.request().postDataJSON().drawings);
        return json({ drawings: savedDrawings[savedDrawings.length - 1] });
      }
      return json({ drawings: [] });
    }
    // Fallback en array: varios consumidores globales hacen `.reduce`.
    return json([]);
  });

  return { savedDrawings };
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

test.describe('TradingView en móvil (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('el gráfico ocupa la pantalla y las herramientas viven en la barra inferior', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');

    const tabs = page.getByRole('navigation', { name: 'Herramientas del gráfico' });
    await expect(tabs).toBeVisible();
    for (const name of ['Indicadores', 'Dibujar', 'Replay', 'Ajustes']) {
      await expect(tabs.getByRole('button', { name: new RegExp(name) })).toBeVisible();
    }
    // La barra de escritorio (Refrescar, selects de crosshair) no se renderiza.
    await expect(page.getByRole('button', { name: 'Refrescar' })).toHaveCount(0);
    await expect(page.locator('#crosshair-mode')).toHaveCount(0);

    const chart = await page.getByTestId('tradingview-chart').boundingBox();
    expect(chart.height).toBeGreaterThan(450);
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/tv-mobile-main.png' });
    expect(errores).toEqual([]);
  });

  test('Ajustes abre una hoja con crosshair y escala segmentados', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    await page.getByRole('button', { name: 'Ajustes' }).click();

    const sheet = page.getByRole('dialog', { name: 'Ajustes del gráfico' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('radio', { name: 'Log' }).click();
    await expect(sheet.getByRole('radio', { name: 'Log' })).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: 'test-results/tv-mobile-settings.png' });
    await sheet.getByRole('button', { name: 'Listo' }).click();
    await expect(sheet).toHaveCount(0);
  });

  test('Indicadores es una hoja de una columna: lista → catálogo → volver', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    await page.getByRole('button', { name: /Indicadores/ }).click();

    const sheet = page.getByRole('dialog', { name: 'Configurar indicadores' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/Activos \(\d+\)/)).toBeVisible();
    await expect(sheet.getByText('Catálogo', { exact: true })).toBeHidden();
    await page.waitForTimeout(300); // deja terminar la animación de entrada
    await page.screenshot({ path: 'test-results/tv-mobile-indicators.png' });

    await sheet.getByRole('button', { name: /Agregar desde catálogo/ }).click();
    await expect(sheet.getByText('Catálogo', { exact: true })).toBeVisible();
    await expect(sheet.getByText(/Activos \(\d+\)/)).toBeHidden();

    await sheet.getByRole('button', { name: 'Volver a la lista' }).click();
    await expect(sheet.getByText(/Activos \(\d+\)/)).toBeVisible();
  });

  test('modo dibujo: traza una línea arrastrando, deshace y vuelve a las pestañas', async ({ page }) => {
    const { savedDrawings } = await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    await expect(page.getByTestId('tradingview-chart')).toBeVisible();

    const box = await page.getByTestId('tradingview-chart').boundingBox();
    await page.getByRole('button', { name: 'Dibujar' }).click();
    const bar = page.getByRole('toolbar', { name: 'Herramientas de dibujo' });
    await expect(bar).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Herramientas del gráfico' })).toHaveCount(0);

    await bar.getByRole('button', { name: 'Línea de tendencia' }).click();
    await expect(bar.getByRole('button', { name: 'Borrar dibujo seleccionado' })).toBeInViewport({ ratio: 1 });
    await page.mouse.move(box.x + 60, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + box.height * 0.4, { steps: 6 });
    await page.mouse.up();

    await expect.poll(() => savedDrawings.at(-1)?.length).toBe(1);
    // Cambiar de modo no debe cambiar el alto del gráfico ni desbordar la página.
    const boxAfter = await page.getByTestId('tradingview-chart').boundingBox();
    expect(Math.abs(boxAfter.height - box.height)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
    const undo = page.getByRole('button', { name: 'Deshacer' });
    await expect(undo).toBeEnabled();
    await page.screenshot({ path: 'test-results/tv-mobile-draw.png' });

    await undo.click();
    await expect.poll(() => savedDrawings.at(-1)?.length).toBe(0);
    await expect(undo).toBeDisabled();

    await page.getByRole('button', { name: 'Listo' }).click();
    await expect(page.getByRole('navigation', { name: 'Herramientas del gráfico' })).toBeVisible();
  });

  test('Replay se acopla abajo como hoja sin tapar el gráfico entero', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    await page.getByRole('button', { name: 'Replay' }).click();

    const panel = page.getByRole('dialog', { name: 'Modo Replay' });
    await expect(panel).toBeVisible();
    const pb = await panel.boundingBox();
    expect(Math.round(pb.y + pb.height)).toBe(844);
    expect(pb.width).toBe(390);
    expect(pb.y).toBeGreaterThan(844 * 0.35);
    await page.screenshot({ path: 'test-results/tv-mobile-replay.png' });
  });
});

test.describe('TradingView en móvil — temporalidades e indicadores', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('favoritas + «más» y el botón Log sincronizado con Ajustes', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    const row = page.getByRole('navigation', { name: 'Temporalidad' });
    await expect(row.getByRole('button', { name: '1W', exact: true })).toHaveCount(0);

    await row.getByRole('button', { name: 'Más temporalidades' }).click();
    const sheet = page.getByRole('dialog', { name: 'Temporalidad' });
    await sheet.getByRole('button', { name: /Marcar 1W como favorita/ }).click();
    await sheet.getByRole('button', { name: '1W', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(row.getByRole('button', { name: '1W', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await row.getByRole('button', { name: 'Log' }).click();
    await expect(row.getByRole('button', { name: 'Log' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await expect(page.getByRole('radio', { name: 'Log' })).toHaveAttribute('aria-checked', 'true');
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('deslizar una fila de indicador muestra «Quitar» y lo elimina', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    await page.getByRole('button', { name: /Indicadores/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Configurar indicadores' });
    await expect(sheet.getByText('Activos (1)')).toBeVisible();

    const label = sheet.getByText(/Squeeze/).first();
    const b = await label.boundingBox();
    await page.mouse.move(b.x + 200, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 20, b.y + 12, { steps: 8 });
    await page.mouse.up();

    await sheet.getByRole('button', { name: /^Quitar / }).click();
    await expect(sheet.getByText('Activos (0)')).toBeVisible();
  });
});

test.describe('TradingView en escritorio', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('mantiene la barra superior y no muestra la barra de pestañas', async ({ page }) => {
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    await expect(page.getByRole('button', { name: 'Refrescar' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Herramientas del gráfico' })).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: /Herramientas de dibujo/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/tv-desktop.png' });
  });
});

const { test, expect } = require('@playwright/test');

// Superposiciones en TradingView: activos y opciones de Deribit sobre el
// gráfico principal (eje izquierdo enfocado, ocultar, tope de 6, móvil, replay).
// La API se simula entera con page.route.

const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};
const DAY = 86_400_000;
const EXPIRY_MS = Date.UTC(2025, 9, 31, 8); // 31 oct 2025 08:00 UTC (vencida)
const INSTRUMENT = 'ETH-31OCT25-4000-C';
const SYMBOLS = ['BTC', 'SOL', 'HYPE', 'XRP', 'AVAX', 'TRX', 'BNB', 'DOGE'];

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

const BASES = { ETH: 2300, BTC: 65000, SOL: 150 };

async function mockApi(page) {
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
    // Limpia las superposiciones solo la primera vez (la recarga debe conservarlas).
    if (!sessionStorage.getItem('e2e_ov_cleared')) {
      localStorage.removeItem('tv_overlays_v1');
      localStorage.removeItem('tv_overlays_hidden_v1');
      sessionStorage.setItem('e2e_ov_cleared', '1');
    }
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams;
    const json = (data) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
    const { pathname } = url;
    if (pathname === '/api/market/candles') {
      const asset = (q.get('asset') || 'ETH').toUpperCase();
      return json(series(q.get('timeframe') || '15m', {
        startTime: Number(q.get('startTime')) || 0,
        endTime: Number(q.get('endTime')) || 0,
        limit: Number(q.get('limit') || 300),
      }, BASES[asset] || 100));
    }
    if (pathname === '/api/market/catalog') {
      return json({
        categories: { crypto: 'Cripto' },
        assets: [
          { id: 'hl-ETH', symbol: 'ETH', datasource: 'hyperliquid', name: 'ETH', category: 'crypto' },
          ...SYMBOLS.map((s) => ({ id: `hl-${s}`, symbol: s, datasource: 'hyperliquid', name: s, category: 'crypto' })),
        ],
      });
    }
    if (pathname === '/api/market/options/expiries') {
      return json([
        { code: '31OCT25', expiryMs: EXPIRY_MS, live: false },
        { code: '28NOV26', expiryMs: Date.UTC(2026, 10, 28, 8), live: true },
      ]);
    }
    if (pathname === '/api/market/options/strikes') {
      return json({
        status: 'done', probed: 3, total: 3, spotRef: 4000,
        strikes: [
          { strike: 3900, call: null, put: null, distancePct: -2.5 },
          { strike: 4000, call: INSTRUMENT, put: null, distancePct: 0 },
        ],
      });
    }
    if (pathname === '/api/market/options/candles') {
      const tf = q.get('timeframe') || '15m';
      const rows = series(tf, {
        startTime: Number(q.get('startTime')) || 0,
        endTime: Number(q.get('endTime')) || 0,
        limit: 300,
      }, 150);
      return json(rows.map((c, i) => ({ ...c, traded: i % 4 !== 0 })));
    }
    if (pathname === '/api/settings/chart-indicators') return json({ indicators: [] });
    return json([]);
  });
}

const openDesktopPicker = async (page) => {
  await page.getByRole('button', { name: /^Superponer/ }).click();
  await expect(page.getByRole('dialog', { name: /Superponer en ETH/ })).toBeVisible();
};

async function addAsset(page, sym) {
  await page.getByRole('button', { name: `Añadir ${sym}`, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Catálogo' }).getByRole('button', { name: `Quitar ${sym}`, exact: true })).toBeVisible();
}

async function gotoDesktop(page) {
  await mockApi(page);
  await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
  await expect(page.locator('canvas').first()).toBeVisible();
}

const chips = (page) => page.getByRole('toolbar', { name: 'Superposiciones' });
const chipBody = (page, sym) => chips(page).getByRole('button', { name: sym, exact: true });

test.describe('TradingView superposiciones (escritorio)', () => {
  test('superponer BTC y SOL: la primera tiene "eje izq." y un clic la mueve', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await gotoDesktop(page);
    await openDesktopPicker(page);
    await addAsset(page, 'BTC');
    await addAsset(page, 'SOL');
    await page.getByRole('button', { name: 'Listo' }).click();

    await expect(chips(page)).toBeVisible();
    await expect(chipBody(page, 'BTC')).toHaveAttribute('aria-pressed', 'true');
    await expect(chipBody(page, 'BTC')).toContainText('eje izq.');
    await expect(chipBody(page, 'SOL')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('eje izq.')).toHaveCount(1);

    await chipBody(page, 'SOL').click();
    await expect(chipBody(page, 'SOL')).toHaveAttribute('aria-pressed', 'true');
    await expect(chipBody(page, 'SOL')).toContainText('eje izq.');
    await expect(chipBody(page, 'BTC')).not.toContainText('eje izq.');
    await expect(page.getByRole('button', { name: /^Superponer/ })).toContainText('2/6');
    expect(errores).toEqual([]);
  });

  test('ocultar BTC la tacha y todo persiste tras recargar', async ({ page }) => {
    await gotoDesktop(page);
    await openDesktopPicker(page);
    await addAsset(page, 'BTC');
    await addAsset(page, 'SOL');
    await page.getByRole('button', { name: 'Listo' }).click();

    await page.getByRole('button', { name: 'Ocultar BTC', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mostrar BTC', exact: true })).toBeVisible();
    await expect(chipBody(page, 'BTC').locator('span').filter({ hasText: /^BTC$/ }))
      .toHaveCSS('text-decoration-line', 'line-through');

    await page.reload();
    await expect(chips(page)).toBeVisible();
    await expect(chipBody(page, 'BTC')).toBeVisible();
    await expect(chipBody(page, 'SOL')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mostrar BTC', exact: true })).toBeVisible();
    await expect(chipBody(page, 'BTC').locator('span').filter({ hasText: /^BTC$/ }))
      .toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.getByRole('button', { name: 'Ocultar SOL', exact: true })).toBeVisible();
  });

  test('una opción vencida salta a su vida y "Volver a ahora" regresa', async ({ page }) => {
    await gotoDesktop(page);
    await expect(page.getByRole('button', { name: 'Volver a ahora' })).toHaveCount(0);
    await openDesktopPicker(page);
    await page.getByRole('tab', { name: 'Opción · Deribit' }).click();
    await expect(page.getByText('BNB y DOGE no cotizan en Deribit')).toHaveCount(0);
    await expect(page.getByText('Vencidos · último año')).toBeVisible();
    await page.getByRole('button', { name: /31 oct 2025/ }).click();
    await expect(page.getByRole('table', { name: 'Strikes' })).toBeVisible();
    await expect(page.getByText('Sin operaciones').first()).toBeVisible();
    await page.getByRole('button', { name: 'Añadir CALL 4000' }).click();
    await expect(page.getByLabel('CALL 4,000 añadida')).toBeVisible();
    await page.getByRole('button', { name: 'Listo' }).click();

    await expect(chipBody(page, INSTRUMENT).or(chips(page).getByRole('button', { name: /ETH.*4000/ }).first())).toBeVisible();
    const back = page.getByRole('button', { name: 'Volver a ahora' });
    await expect(back).toBeVisible();
    await back.click();
    await expect(back).toHaveCount(0);
  });

  test('tope de 6: "Añadir" queda desactivado', async ({ page }) => {
    await gotoDesktop(page);
    await openDesktopPicker(page);
    for (const s of SYMBOLS.slice(0, 6)) await addAsset(page, s);
    await expect(page.getByRole('button', { name: 'Añadir BNB', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Añadir DOGE', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Listo' }).click();
    await expect(page.getByRole('button', { name: /^Superponer/ })).toContainText('6/6');
    await expect(chips(page).getByRole('button', { name: /^Añadir$/ })).toBeDisabled();
  });

  test('replay: los chips desaparecen al activarlo y vuelven al salir', async ({ page }) => {
    await gotoDesktop(page);
    await openDesktopPicker(page);
    await addAsset(page, 'BTC');
    await page.getByRole('button', { name: 'Listo' }).click();
    await expect(chips(page)).toBeVisible();

    await page.getByRole('button', { name: /^Replay/ }).click();
    await page.getByRole('button', { name: 'Iniciar replay' }).click();
    await expect(page.getByRole('button', { name: 'Salir del modo replay' })).toBeVisible();
    await expect(chips(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Salir del modo replay' }).click();
    await expect(chips(page)).toBeVisible();
    await expect(chipBody(page, 'BTC')).toBeVisible();
  });
});

test.describe('TradingView superposiciones (móvil 390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('pestaña Superponer: añade BTC y el chip enfocado abre "Acciones" con "Ver en grande"', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/trading-view?symbol=ETH&datasource=hyperliquid&tf=15m');
    const tabs = page.getByRole('navigation', { name: 'Herramientas del gráfico' });
    await expect(tabs.getByRole('button', { name: /Superponer/ })).toBeVisible();

    await tabs.getByRole('button', { name: /Superponer/ }).click();
    await expect(page.getByRole('dialog', { name: 'Superponer' }).or(page.getByText('0 de 6')).first()).toBeVisible();
    await page.getByRole('button', { name: 'Añadir BTC', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Catálogo' }).getByRole('button', { name: 'Quitar BTC', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Superponer' })).toHaveCount(0);

    const pill = page.getByRole('group', { name: 'Superposiciones' }).getByRole('button', { name: /^BTC/ });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('aria-pressed', 'true'); // enfocada
    const box = await pill.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);

    await pill.tap();
    await expect(page.getByText('Acciones', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver en grande' })).toBeVisible();
    await page.screenshot({ path: 'test-results/tv-overlays-mobile.png' });
    expect(errores).toEqual([]);
  });
});

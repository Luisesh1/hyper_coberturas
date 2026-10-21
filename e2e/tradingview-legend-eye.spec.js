const { test, expect } = require('@playwright/test');

// Ojo en la leyenda de indicadores: oculta/muestra un indicador con un clic
// (escritorio) o un toque (móvil) y guarda la configuración.

function buildCandles() {
  const step = 15 * 60_000;
  const start = Math.floor(Date.now() / step) * step - 199 * step;
  let price = 2300;
  return Array.from({ length: 200 }, (_, i) => {
    const open = price;
    const close = open + Math.sin(i / 4) * 6 + (i % 3 === 0 ? -3 : 4);
    price = close;
    const time = start + i * step;
    return {
      time, closeTime: time + step, open,
      high: Math.max(open, close) + 3, low: Math.min(open, close) - 3, close, volume: 1000 + i,
    };
  });
}

const INDICATORS = [
  { uid: 'e10', type: 'ema', visible: true, params: { length: 10 }, style: { color: '#ef4444' } },
  { uid: 'e55', type: 'ema', visible: true, params: { length: 55 }, style: { color: '#3b82f6' } },
];

async function mockApi(page) {
  const candles = buildCandles();
  const saves = [];
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
    localStorage.removeItem('tv_overlays_v1');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }),
    });
    if (url.pathname === '/api/market/candles') {
      const limit = Number(url.searchParams.get('limit') || candles.length);
      return json(url.searchParams.get('endTime') ? [] : candles.slice(-limit));
    }
    if (url.pathname === '/api/settings/chart-indicators') {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        saves.push(body.indicators);
        return json({ indicators: body.indicators });
      }
      return json({ indicators: INDICATORS });
    }
    if (url.pathname.startsWith('/api/settings/chart-drawings/')) return json({ drawings: [] });
    return json([]);
  });
  return saves;
}

test('escritorio: el ojo oculta y vuelve a mostrar un indicador desde la leyenda', async ({ page }) => {
  const saves = await mockApi(page);
  await page.goto('/trading-view');
  const legend = page.getByLabel('Valores de indicadores');
  await expect(legend.getByText('EMA 10')).toBeVisible();

  await legend.getByRole('button', { name: 'Ocultar EMA 10' }).click();
  const show = legend.getByRole('button', { name: 'Mostrar EMA 10' });
  await expect(show).toBeVisible();
  await expect(show).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].find((i) => i.uid === 'e10').visible).toBe(false);
  expect(saves[0].find((i) => i.uid === 'e55').visible).toBe(true);

  await show.click();
  await expect(legend.getByRole('button', { name: 'Ocultar EMA 10' })).toBeVisible();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1].find((i) => i.uid === 'e10').visible).toBe(true);
});

test.describe('móvil', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tocar un chip de la leyenda oculta el indicador y otro toque lo muestra', async ({ page }) => {
    const saves = await mockApi(page);
    await page.goto('/trading-view');
    const chip = page.getByRole('button', { name: 'Ocultar EMA 55' });
    await expect(chip).toBeVisible();
    await chip.tap();
    await expect(page.getByRole('button', { name: 'Mostrar EMA 55' })).toBeVisible();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].find((i) => i.uid === 'e55').visible).toBe(false);
    await page.getByRole('button', { name: 'Mostrar EMA 55' }).tap();
    await expect(page.getByRole('button', { name: 'Ocultar EMA 55' })).toBeVisible();
  });
});

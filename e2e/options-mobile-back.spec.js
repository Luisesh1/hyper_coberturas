const { test, expect } = require('@playwright/test');

// Opciones en el teléfono: el detalle de un bot (y de una estrategia) vive en
// la URL. El «atrás» del sistema vuelve a la lista igual que «Volver», y
// recargar conserva la pantalla abierta. /api mockeada.

const bot = (id, name) => ({
  id, name, template: 'alert_signal', mode: 'shadow', status: 'waiting', limits: {},
  underlying: 'BTC', underlyings: ['BTC'],
  params: { structure: 'buy_with', budgetUsdt: 400, budgetFractions: 4, maxOpenPositions: 3, alertIds: [11] },
  alerts: [{ id: 11, name: 'Alcista', direction: 'bullish', assetList: ['BTCUSDT'] }],
  pnl30d: { shadow: 10, live: 0 }, pnlSeries: [0, 5, 10], feesUsdt: 1, openPositions: { shadow: 0, live: 0 }, lastSignal: null,
});
const BOTS = [bot(1, 'Bot uno'), bot(2, 'Bot dos')];

async function mockApi(page) {
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (data) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }),
    });
    if (pathname === '/api/options/auto-bots') return json(BOTS);
    if (pathname === '/api/options/underlyings') return json([{ underlying: 'BTC', spot: 68000, change24hPct: 1 }]);
    if (/^\/api\/options\/strategies\/\d+$/.test(pathname)) {
      const b = BOTS.find((x) => x.id === Number(pathname.split('/').pop()));
      return json({ ...b, kpis: { shadow: {}, live: {} }, usage: {}, events: [], positions: [], closedPositions: [] });
    }
    return json([]);
  });
}

test('móvil · atrás del sistema, «Volver» y recarga en el detalle de un bot', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  await mockApi(page);
  await page.goto('/opciones');
  await page.getByRole('link', { name: 'Auto' }).click();
  await expect(page).toHaveURL(/\?tab=auto$/);

  const list = page.getByRole('list', { name: 'Bots' });
  const detail = page.getByRole('dialog', { name: 'Bot dos' });

  // «Atrás» del sistema: vuelve a la lista de bots, no al menú de Opciones.
  await list.getByRole('button', { name: 'Bot dos', exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(/\?tab=auto&bot=2$/);
  await page.goBack();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\?tab=auto$/);
  await expect(list).toBeVisible();

  // Recargar conserva el detalle abierto.
  await list.getByRole('button', { name: 'Bot dos', exact: true }).click();
  await expect(detail).toBeVisible();
  await page.reload();
  await expect(detail).toBeVisible();
  await page.screenshot({ path: 'test-results/options-mobile-back-reload.png' });

  // «Volver» hace lo mismo que el atrás del sistema.
  await detail.getByRole('button', { name: 'Volver' }).click();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\?tab=auto$/);
  await expect(list).toBeVisible();
  await ctx.close();
});

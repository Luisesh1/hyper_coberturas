const { test, expect } = require('@playwright/test');

// Trading automatizado · cada tarjeta de bot muestra cuántas operaciones tiene
// abiertas en su libro activo (sombra o real), en escritorio y en móvil, sin
// desbordar la tarjeta. /api mockeada.

const bot = (id, name, mode, openPositions, pnl) => ({
  id, name, template: 'alert_signal', mode, status: 'waiting', limits: {},
  underlying: 'BTC', underlyings: ['BTC', 'ETH'],
  params: { structure: 'buy_with', budgetUsdt: 400, budgetFractions: 4, maxOpenPositions: 3, alertIds: [11, 12] },
  alerts: [
    { id: 11, name: 'Alcista', direction: 'bullish', assetList: ['BTCUSDT'] },
    { id: 12, name: 'Bajista', direction: 'bearish', assetList: ['BTCUSDT'] },
  ],
  pnl30d: { shadow: mode === 'shadow' ? pnl : 0, live: mode === 'live' ? pnl : 0 },
  pnlSeries: [0, pnl / 2, pnl], feesUsdt: 12.5, openPositions, lastSignal: null,
});

const BOTS = [
  bot(1, '1h 4h call', 'shadow', { shadow: 1, live: 0 }, 65.66),
  bot(2, '15m bot', 'shadow', { shadow: 2, live: 0 }, 662.02),
  bot(3, '15m bot girar', 'shadow', { shadow: 0, live: 0 }, -151.52),
];

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

async function expectCards(page) {
  const list = page.getByRole('list', { name: 'Bots' });
  const card = (name) => list.getByRole('button', { name, exact: true }).locator('xpath=ancestor::li');
  await expect(card('1h 4h call').getByText('1 activa', { exact: true })).toBeVisible();
  await expect(card('15m bot').getByText('2 activas', { exact: true })).toBeVisible();
  await expect(card('15m bot').getByLabel('Operaciones activas: 2 de 3 máx.')).toBeVisible();
  await expect(card('15m bot girar').getByText('0 activas', { exact: true })).toBeVisible();
  // La píldora no se sale de su tarjeta.
  const overflow = await list.locator('li').evaluateAll((lis) => lis.map((li) => li.firstElementChild.scrollWidth - li.firstElementChild.clientWidth));
  expect(Math.max(...overflow)).toBeLessThanOrEqual(0);
}

test.describe('Tarjetas de bots · operaciones activas', () => {
  test('escritorio', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await mockApi(page);
    await page.goto('/opciones?tab=auto');
    await expectCards(page);
    await page.getByRole('list', { name: 'Bots' }).screenshot({ path: 'test-results/bot-card-active-ops-desktop.png' });
  });

  test('móvil (390px)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await ctx.newPage();
    await mockApi(page);
    await page.goto('/opciones?tab=auto');
    await expectCards(page);
    await page.screenshot({ path: 'test-results/bot-card-active-ops-mobile.png' });
    await ctx.close();
  });
});

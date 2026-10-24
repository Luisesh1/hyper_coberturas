const { test, expect } = require('@playwright/test');

/**
 * Orquestador LP: la sección «Tramos» lista los 3 tramos y la «Apertura» de
 * la tarjeta es la del tramo vivo (dentro de su rango), no la del primer LP.
 *
 * Hermético: mockea la API.
 */

const WALLET = '0xb2bd00000000000000000000000000000000375a';
const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const SHOT_DIR = process.env.E2E_SHOT_DIR;

const ORCHESTRATOR = {
  id: 57,
  userId: 1,
  name: 'T57 · ETH/USDC',
  network: 'arbitrum',
  version: 'v3',
  walletAddress: WALLET,
  token0Symbol: 'WETH',
  token1Symbol: 'USDC',
  phase: 'lp_active',
  status: 'active',
  activePositionIdentifier: '3003',
  activeProtectedPoolId: null,
  initialTotalUsd: 1000,
  strategyConfig: { rangeWidthPct: 5, edgeMarginPct: 40 },
  strategyState: {},
  accounting: { lpFeesUsd: 12, priceDriftUsd: -2, gasSpentUsd: 1, swapSlippageUsd: 0.5, totalNetPnlUsd: 8.5, lpCount: 3 },
  lastEvaluation: {
    poolSnapshot: {
      identifier: '3003',
      rangeLowerPrice: 2401.9,
      rangeUpperPrice: 2628.1,
      priceCurrent: 2515,
      // Precio de apertura del PRIMER LP: fuera del rango actual.
      priceAtOpen: 2668.73,
      currentValueUsd: 1000,
    },
  },
  activeSegment: {
    id: 3, seq: 3, status: 'open', openedAt: now - 3_600_000,
    openPrice: 2510, rangeLowerPrice: 2401.9, rangeUpperPrice: 2628.1, closingStartedAt: null,
  },
  createdAt: now - 86_400_000,
  updatedAt: now,
};

const FULL = { lpFeesUsd: 0, gasSpentUsd: 0.4, swapSlippageUsd: 0.1, priceDriftUsd: 0, capitalAdjustmentsUsd: 0, totalNetPnlUsd: 0 };

function segment(seq, over = {}) {
  return {
    id: seq, seq, status: 'closed', accuracy: 'exact',
    openedAt: now - (4 - seq) * 7_200_000, closedAt: now - (3 - seq) * 7_200_000,
    rangeLowerPrice: 2300 + seq * 30, rangeUpperPrice: 2500 + seq * 40,
    openPrice: 2400, closePrice: 2600, openReason: 'rerange', closeReason: 'range_exit_above',
    accounting: { ...FULL, lpFeesUsd: 4, priceDriftUsd: -1, totalNetPnlUsd: 2.5 },
    coverage: { adjustments: 3, avgPct: 96 },
    ...over,
  };
}

const SEGMENTS = {
  segments: [
    segment(3, { status: 'open', closedAt: null, closePrice: null, closeReason: null, openPrice: 2510,
      rangeLowerPrice: 2401.9, rangeUpperPrice: 2628.1, accounting: { ...FULL, lpFeesUsd: 4, totalNetPnlUsd: 3.5 } }),
    segment(2, { closeReason: 'manual_rerange' }),
    segment(1, { accuracy: 'approximate', closeReason: 'unknown' }),
  ],
  totals: { sumNetPnlUsd: 8.5, orchestratorNetPnlUsd: 8.5, differenceUsd: 0 },
};

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
    if (pathname === '/api/lp-orchestrators') return json([ORCHESTRATOR]);
    if (pathname === '/api/lp-orchestrators/57/segments') return json(SEGMENTS);
    if (/\/api\/lp-orchestrators\/57\/segments\/\d+$/.test(pathname)) {
      const id = Number(pathname.split('/').pop());
      return json({ ...SEGMENTS.segments.find((s) => s.id === id), events: [], rebalances: [] });
    }
    if (pathname.endsWith('/protection-ops')) return json({ hedges: [], rebalances: [], cycles: [] });
    return json([]);
  });
}

for (const vp of [{ name: 'escritorio', width: 1400, height: 1000 }, { name: 'móvil', width: 390, height: 844 }]) {
  test(`${vp.name}: la sección Tramos muestra 3 tramos y la Apertura está dentro del rango`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await mockApi(page);
    await page.goto('/lp-orchestrator');

    const card = page.locator('#orchestrator-57');
    await expect(card).toBeVisible({ timeout: 15000 });

    // Apertura de la tarjeta = precio de apertura del tramo vivo (2,510), dentro de 2,401.9 – 2,628.1.
    const apertura = card.getByText('Apertura', { exact: true }).first();
    await expect(apertura).toBeVisible();
    const pinText = await apertura.locator('..').textContent();
    const price = Number((pinText.match(/[\d,]+(?:\.\d+)?/) || [''])[0].replace(/,/g, ''));
    expect(price).toBeGreaterThanOrEqual(2401.9);
    expect(price).toBeLessThanOrEqual(2628.1);
    expect(pinText).not.toContain('2,668');

    // El panel de contabilidad está plegado en <details>.
    await card.locator('details summary').filter({ hasText: 'Posición LP' }).click();
    await card.getByRole('button', { name: /Tramos/ }).click();
    const rows = card.getByRole('button', { name: /^#\d/ });
    await expect(rows).toHaveCount(3);
    await expect(card.getByText('aproximado')).toHaveCount(1);
    await expect(card.getByText('Diferencia de reconstrucción')).toHaveCount(0);

    await rows.first().click();
    await expect(card.getByText('Reajustes del short')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(0);

    if (SHOT_DIR) {
      await card.getByRole('button', { name: /Tramos/ }).scrollIntoViewIfNeeded();
      await card.getByRole('button', { name: /Tramos/ }).locator('..').screenshot({
        path: `${SHOT_DIR}/task-7-tramos-${vp.width}.png`,
      });
    }
  });
}

const { test, expect } = require('@playwright/test');

/**
 * Métricas → orquestador: cada wallet muestra sus orquestadores abiertos
 * (nombre + id) y el enlace lleva a /lp-orchestrator con esa tarjeta centrada
 * y resaltada, aunque hubiera un filtro que la ocultara.
 *
 * Hermético: mockea la API (la base local no tiene orquestadores activos).
 */

const WALLET = '0xb2bd00000000000000000000000000000000375a';
const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;

function orchestrator(id, name, over = {}) {
  return {
    id,
    userId: 1,
    name,
    network: 'arbitrum',
    version: 'v4',
    walletAddress: WALLET,
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
    phase: 'idle',
    status: 'active',
    activePositionIdentifier: null,
    initialTotalUsd: 300,
    strategyConfig: {},
    strategyState: {},
    accounting: {},
    createdAt: now,
    updatedAt: now - id,
    ...over,
  };
}

// Con muchas tarjetas el orquestador enlazado queda fuera de la vista inicial.
const ORCHESTRATORS = [
  ...Array.from({ length: 8 }, (_, i) => orchestrator(100 + i, `relleno ${i}`)),
  orchestrator(77, 'pp9 · ETH/USDC'),
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
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });

    if (pathname === '/api/wallet-metrics') {
      return json([{
        id: 1,
        address: WALLET,
        status: 'active',
        openOrchestrators: [{ id: 77, name: 'pp9 · ETH/USDC' }],
        latest: {
          capturedAt: now,
          totals: { totalUsd: 615.29, tokensUsd: 15, lpUsd: 500, hlUsd: 100.29 },
          isPartial: false,
          staleSources: [],
        },
      }]);
    }
    if (pathname === '/api/wallet-metrics/snapshots') return json({ 1: [] });
    if (pathname === '/api/lp-orchestrators') return json(ORCHESTRATORS);
    if (pathname.endsWith('/protection-ops')) return json({ hedges: [], rebalances: [], cycles: [] });
    return json([]);
  });
}

for (const vp of [{ name: 'escritorio', width: 1400, height: 900 }, { name: 'móvil', width: 390, height: 844 }]) {
  test(`${vp.name}: el orquestador abierto de la wallet enlaza a su tarjeta`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await mockApi(page);
    await page.goto('/metricas');

    const link = page.getByRole('link', { name: /pp9 · ETH\/USDC/ });
    await expect(link).toBeVisible({ timeout: 15000 });
    await expect(link).toContainText('#77');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(0);

    await link.click();
    await expect(page).toHaveURL(/\/lp-orchestrator$/);
    const card = page.locator('#orchestrator-77');
    await expect(card).toBeInViewport({ timeout: 10000 });
    await expect(card).toHaveClass(/gridItemFocused/);
  });
}

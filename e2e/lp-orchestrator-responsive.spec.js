const { test, expect } = require('@playwright/test');

/**
 * Responsividad de /lp-orchestrator tras el rediseño (veredicto + riel +
 * cola de acciones).
 *
 * No comprueba estética: comprueba que NADA se descuadre. Concretamente, que
 * abrir todo lo que se puede abrir —los dos `<details>`, el menú de acciones y
 * los modales— no provoque scroll horizontal ni saque contenido de su tarjeta,
 * a cuatro anchos distintos.
 *
 * Es hermético: mockea la API entera, así no depende de que haya un
 * orquestador vivo en la base (la flota rota seguido) ni de un backend.
 */

const VIEWPORTS = [
  { name: 'desktop ancho', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 800 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'móvil', width: 390, height: 844 },
];

function orchestrator(over = {}) {
  const now = Date.now();
  return {
    id: 45,
    userId: 1,
    accountId: 1,
    name: 'pp8 · ETH/USDC',
    network: 'arbitrum',
    version: 'v4',
    walletAddress: '0xC57B9C0820579934B2537B77112B94D956DE1705',
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
    inferredAsset: 'ETH',
    feeTier: 3000,
    phase: 'lp_active',
    status: 'active',
    activePositionIdentifier: '191720',
    activePoolAddress: '0x0000000000000000000000000000000000dead',
    activeProtectedPoolId: 18,
    initialTotalUsd: 330,
    strategyConfig: {
      rangeWidthPct: 10,
      edgeMarginPct: 40,
      costToRewardThreshold: 0.3,
      reinvestThresholdUsd: 25,
      urgentAlertRepeatMinutes: 30,
    },
    protectionConfig: { enabled: true, accountId: 1, configuredNotionalUsd: 50 },
    strategyState: {},
    lastEvaluation: {
      timeInRangePct: 96.3,
      unclaimedFeesUsd: 1.2,
      poolSnapshot: {
        priceCurrent: 2415.55,
        priceAtOpen: 2459.65,
        priceLower: 2387.53,
        priceUpper: 2519.99,
        priceQuoteSymbol: 'USDC',
        priceBaseSymbol: 'ETH',
        activeForMs: 570000000,
        openedAt: Math.floor((now - 570000000) / 1000),
        currentOutOfRangeSide: null,
      },
    },
    lastEvaluationAt: now - 12000,
    accounting: {
      lpFeesUsd: 9.39,
      gasSpentUsd: 0,
      swapSlippageUsd: 0,
      priceDriftUsd: -3.35,
      hedgeRealizedPnlUsd: -11.63,
      hedgeUnrealizedPnlUsd: 0.59,
      hedgeFundingUsd: -0.24,
      hedgeExecutionFeesUsd: 0.8,
      hedgeSlippageUsd: 1.09,
      totalNetPnlUsd: -7.13,
      lpCount: 3,
    },
    nextEligibleAttemptAt: null,
    cooldownReason: null,
    consecutiveFailures: 0,
    lastError: null,
    lastDecision: 'hold',
    createdAt: now - 570000000,
    updatedAt: now - 12000,
    ...over,
  };
}

// Un segundo orquestador EN PROBLEMAS: es el que hace aparecer la cola de
// acciones, que de otro modo no se renderiza y quedaría sin probar.
const enProblemas = orchestrator({
  id: 46,
  name: 'pp9 · ETH/USDC',
  phase: 'urgent_adjust',
  walletAddress: '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde',
  lastEvaluation: {
    ...orchestrator().lastEvaluation,
    evaluation: { outOfRangeSide: 'below' },
  },
});

async function mockApi(page) {
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
  });

  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const { pathname } = new URL(route.request().url());
    // El cliente HTTP exige `success: true` y devuelve `payload.data`: sin la
    // bandera, toda respuesta —aunque sea 200— se trata como error.
    const json = (data) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });

    if (pathname === '/api/lp-orchestrators') {
      return json([enProblemas, orchestrator()]);
    }
    if (pathname.endsWith('/protection-ops')) {
      return json({ hedges: [], rebalances: [], cycles: [] });
    }
    if (pathname.startsWith('/api/lp-orchestrators/') && pathname.includes('/action-log')) {
      return json([]);
    }
    if (pathname === '/api/settings/hyperliquid-accounts') {
      return json([{ id: 1, alias: 'cuenta-1', address: '0xC57B9C08', isDefault: true }]);
    }
    // Fallback en ARRAY, no en objeto: varios consumidores hacen `.reduce`
    // sobre la respuesta y un `{}` tumba la app entera con
    // "c.reduce is not a function" — la página queda en blanco y el fallo se
    // lee como si el rediseño estuviera roto.
    return json([]);
  });
}

/** Scroll horizontal del documento: el síntoma clásico de "se descuadró". */
async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/**
 * Contenido que se sale de su propia tarjeta. Detecta lo que el scroll del
 * documento no ve: una fila interna más ancha que su contenedor, que en un
 * grid queda recortada en vez de empujar la página.
 */
async function elementosDesbordados(page) {
  return page.evaluate(() => {
    const desbordes = [];
    for (const card of document.querySelectorAll('article')) {
      const caja = card.getBoundingClientRect();
      for (const hijo of card.querySelectorAll('*')) {
        const r = hijo.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // 1px de tolerancia por redondeo subpíxel del navegador.
        if (r.right > caja.right + 1 || r.left < caja.left - 1) {
          desbordes.push(`${hijo.className || hijo.tagName} sale de su tarjeta`);
        }
      }
    }
    return desbordes.slice(0, 8);
  });
}

async function irAlOrquestador(page) {
  await mockApi(page);
  // Se navega por URL en vez de clicar el botón del nav: a 390px la barra de
  // navegación se colapsa y el botón queda fuera del viewport, que es un
  // problema de OTRA pantalla y no lo que este test mide.
  await page.goto('/lp-orchestrator');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('pp8 · ETH/USDC')).toBeVisible({ timeout: 15000 });
}

test.describe('Orquestador LP — la interfaz no se descuadra', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} (${vp.width}px): con todo abierto no hay desbordes`, async ({ page }) => {
      const errores = [];
      page.on('pageerror', (e) => errores.push(e.message));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await irAlOrquestador(page);

      // ── Estado cerrado ──
      expect(await horizontalOverflow(page)).toBe(0);

      // ── La cola de acciones aparece (hay un orquestador urgente) ──
      await expect(page.getByText('Requiere tu atención')).toBeVisible();

      // ── El veredicto y su porcentaje ──
      await expect(page.getByText('-$7.13').first()).toBeVisible();
      await expect(page.getByText('-2.16%').first()).toBeVisible();

      // ── La wallet del LP en el encabezado ──
      await expect(page.getByText('0xC57B…1705').first()).toBeVisible();

      // ── Abrir TODOS los colapsables ──
      const detalles = page.locator('details');
      const total = await detalles.count();
      expect(total).toBeGreaterThan(0);
      for (let i = 0; i < total; i += 1) {
        await detalles.nth(i).locator('summary').first().click();
      }
      await page.waitForTimeout(150);

      expect(await horizontalOverflow(page)).toBe(0);
      expect(await elementosDesbordados(page)).toEqual([]);

      // ── Abrir el menú de acciones y comprobar que cabe en pantalla ──
      await page.getByRole('button', { name: 'Más acciones' }).first().click();
      const menu = page.getByRole('menu').first();
      await expect(menu).toBeVisible();

      const caja = await menu.boundingBox();
      expect(caja).not.toBeNull();
      expect(caja.x).toBeGreaterThanOrEqual(0);
      expect(caja.x + caja.width).toBeLessThanOrEqual(vp.width + 1);
      expect(await horizontalOverflow(page)).toBe(0);

      // El menú se cierra al hacer clic fuera. La etiqueta es específica
      // ("de acciones") porque a <=768px el nav móvil de la app tiene su
      // propio botón "Cerrar menú" y ambos colisionarían.
      await page.getByRole('button', { name: 'Cerrar menú de acciones' }).click();
      await expect(menu).toBeHidden();

      expect(errores).toEqual([]);
    });
  }

  test('los modales tampoco desbordan a 390px', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));

    await page.setViewportSize({ width: 390, height: 844 });
    await irAlOrquestador(page);

    // Modal de incidencia, que se abre desde el chip del orquestador urgente.
    await page.getByRole('button', { name: /Fuera de rango/ }).first().click();
    // Por rol: el mismo texto vive también en la fila de la cola de acciones.
    await expect(page.getByRole('heading', { name: 'Ajuste urgente recomendado' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.keyboard.press('Escape');

    // Bitácora y configuración viven en el menú tras el rediseño.
    await page.getByRole('button', { name: 'Más acciones' }).first().click();
    await page.getByRole('menuitem', { name: 'Bitácora' }).click();
    await page.waitForTimeout(200);
    expect(await horizontalOverflow(page)).toBe(0);

    expect(errores).toEqual([]);
  });
});

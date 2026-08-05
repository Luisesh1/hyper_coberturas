const { test, expect } = require('@playwright/test');

const hasBackend = Boolean(process.env.E2E_API_TARGET);

async function login(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('admin').fill(process.env.E2E_USERNAME || 'admin');
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_PASSWORD || 'admin123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Backtesting' })).toBeVisible({ timeout: 10000 });
}

// Construye un orquestador sintético con la forma exacta de mapRow()
// (server/src/repositories/lp-orchestrator.repository.js) para no depender
// de que exista un LP roto de verdad en la base de datos: el estado real
// puede cambiar en cualquier momento (LPs cerrados, orquestadores
// archivados) y el test no debe volverse falso-negativo por eso.
//
// `activeProtectedPoolId` es el único campo que cambia entre "sin
// cobertura" y "con cobertura" — así el par de tests deja evidencia de que
// la aserción realmente sigue ese campo y no otra cosa.
function buildSyntheticOrchestrator({ activeProtectedPoolId }) {
  const now = Date.now();
  return {
    id: 999001,
    userId: 1,
    accountId: 8,
    name: 'e2e-synthetic-unprotected',
    network: 'arbitrum',
    version: 'v3',
    walletAddress: '0x0000000000000000000000000000000000e2e0',
    token0Address: '0x0000000000000000000000000000000000a0a0',
    token1Address: '0x0000000000000000000000000000000000b0b0',
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
    inferredAsset: 'ETH',
    feeTier: 3000,
    phase: 'lp_active',
    status: 'active',
    activePositionIdentifier: '191720',
    activePoolAddress: '0x0000000000000000000000000000000000dead',
    activeProtectedPoolId,
    initialTotalUsd: 500,
    strategyConfig: {
      rangeWidthPct: 10,
      edgeMarginPct: 40,
      costToRewardThreshold: 0.3,
      reinvestThresholdUsd: 25,
      urgentAlertRepeatMinutes: 30,
    },
    protectionConfig: { enabled: true, accountId: 8, configuredNotionalUsd: 50 },
    strategyState: {
      protectionRetry: { attempts: 2, nextAttemptAt: now + 600000, lastError: 'margen insuficiente' },
    },
    lastEvaluation: null,
    lastEvaluationAt: now - 60000,
    accounting: {
      lpFeesUsd: 0,
      gasSpentUsd: 0,
      swapSlippageUsd: 0,
      hedgeRealizedPnlUsd: 0,
      hedgeUnrealizedPnlUsd: 0,
      hedgeFundingUsd: 0,
      hedgeExecutionFeesUsd: 0,
      hedgeSlippageUsd: 0,
      priceDriftUsd: 0,
      totalNetPnlUsd: 0,
      lpCount: 0,
    },
    nextEligibleAttemptAt: null,
    cooldownReason: null,
    consecutiveFailures: 0,
    lastError: null,
    lastUrgentAlertAt: null,
    lastDecision: null,
    createdAt: now - 3600000,
    updatedAt: now - 60000,
    stoppedAt: null,
  };
}

async function interceptWithSyntheticOrchestrator(page, { activeProtectedPoolId }) {
  await page.route('**/api/lp-orchestrators', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    rows.unshift(buildSyntheticOrchestrator({ activeProtectedPoolId }));
    await route.fulfill({ response, json: { ...body, data: rows } });
  });
}

async function openOrchestratorPage(page) {
  await login(page);
  await page.getByRole('button', { name: '🎛 Orquestador LP' }).click();
  await page.waitForLoadState('networkidle');
}

test.describe('Orquestador — LP sin cobertura', () => {
  test.skip(!hasBackend, 'Requiere E2E_API_TARGET');

  test('pinta el chip "Sin cobertura" cuando el LP activo no tiene proteccion vinculada', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Inyectamos un orquestador sintético con activeProtectedPoolId: null
    // en vez de mutar uno real — así el test no depende del estado actual
    // de la base de datos (que puede no tener ningún LP activo).
    await interceptWithSyntheticOrchestrator(page, { activeProtectedPoolId: null });

    await openOrchestratorPage(page);

    await expect(page.getByText('Sin cobertura').first()).toBeVisible({ timeout: 10000 });

    expect(errors).toEqual([]);
  });

  test('NO pinta el chip cuando el mismo LP sintético tiene proteccion vinculada', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Mismo orquestador sintético, único campo distinto: activeProtectedPoolId
    // deja de ser null. Si el chip desaparece acá, la aserción del test
    // anterior está siguiendo ese campo y no otra cosa (falso positivo).
    await interceptWithSyntheticOrchestrator(page, { activeProtectedPoolId: 77 });

    await openOrchestratorPage(page);

    await expect(page.getByText('e2e-synthetic-unprotected').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Sin cobertura')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});

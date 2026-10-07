const { test, expect } = require('@playwright/test');

// Corre contra Docker (e2e/playwright-docker.config.js, localhost:5174) con una
// sesión ya emitida: E2E_TOKEN (JWT) y E2E_USER (JSON del usuario). Las rutas
// /api/cross-chain/* se simulan y la wallet es un provider EIP-1193 de solo
// lectura: el test no firma nada ni toca fondos.
const TOKEN = process.env.E2E_TOKEN;
const USER = process.env.E2E_USER;
const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

const PLAN = {
  id: 77,
  walletAddress: WALLET,
  destinationNetwork: 'base',
  profile: 'low',
  status: 'executing',
  request: {
    network: 'base',
    version: 'v4',
    totalUsdTarget: 1000,
    token0: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 },
    token1: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    wizardContext: { fee: 500 },
  },
  steps: [
    { order: 1, sourceNetwork: 'arbitrum', status: 'delivered', token: { symbol: 'USDC', decimals: 6, isNative: false } },
    { order: 2, sourceNetwork: 'arbitrum', status: 'source_confirmed', token: { symbol: 'ETH', decimals: 18, isNative: true } },
  ],
};

const byProfile = (gasO, gasD) => ({
  gasOrigin: { expectedUsd: gasO, maxUsd: gasO * 2 },
  bridgeUsd: 0.34,
  gasDestination: { expectedUsd: gasD, maxUsd: gasD * 2 },
  swaps: { expectedUsd: 0, maxUsd: 0 },
  totalExpectedUsd: gasO + 0.34 + gasD,
  totalMaxUsd: gasO * 2 + 0.34 + gasD * 2,
  pctOfTarget: ((gasO + 0.34 + gasD) / 1000) * 100,
});

const ANALYSIS = {
  needsCrossChain: true,
  totalUsdTarget: 1000,
  thresholdPct: 3,
  destination: { network: 'base', label: 'Base', nativeSymbol: 'ETH', lacksGas: true, deficitUsd: { token0: 525, token1: 345 }, localUsableUsd: 180 },
  balances: {
    totalUsd: 1270.36,
    networks: [
      { network: 'base', label: 'Base', status: 'ok', isDestination: true, rows: [{ id: 'base:usdc', symbol: 'USDC', decimals: 6, balanceRaw: '180000000', usd: 180, role: 'destination', reason: 'Se usa directo en el LP' }] },
      { network: 'arbitrum', label: 'Arbitrum One', status: 'ok', rows: [
        { id: 'arbitrum:usdc', symbol: 'USDC', decimals: 6, balanceRaw: '420000000', usd: 420, role: 'used', reason: 'Costo 0.04 %', usedAmountRaw: '345000000' },
        { id: 'arbitrum:native', symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: '210000000000000000', usd: 550.2, role: 'used', reason: 'Costo 0.05 %', usedAmountRaw: '200400000000000000' },
      ] },
      { network: 'ethereum', label: 'Ethereum', status: 'ok', rows: [{ id: 'ethereum:native', symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: '20000000000000000', usd: 52.4, role: 'excluded', reason: 'Costo $1.92 = 3.7 % > umbral 3 %' }] },
      { network: 'robinhood', label: 'Robinhood Chain', status: 'ok', rows: [{ id: 'robinhood:usdg', symbol: 'USDG', decimals: 6, balanceRaw: '25000000', usd: 25, role: 'not_needed', reason: 'El déficit se cubre con orígenes más baratos' }] },
    ],
  },
  steps: [
    {
      order: 1, sourceNetwork: 'arbitrum', token: { symbol: 'USDC', decimals: 6, isNative: false }, amountRaw: '345000000', amountUsd: 345,
      deliveryToken: { symbol: 'USDC', decimals: 6 }, receivedRaw: '344890000', receivedUsd: 344.89, provider: 'across', carriesDestinationGas: false,
      alternative: { provider: 'lifi', costUsd: 0.98 },
      costs: { bridgeCostUsd: 0.11, bridgeFees: [{ name: 'Relayer (Across)', amountUsd: 0.11, included: true }], gasOrigin: { profilesMatter: false } },
      costsByProfile: { low: { gasOriginExpectedUsd: 0.04, gasOriginMaxUsd: 0.08, expectedUsd: 0.15, maxUsd: 0.19 }, medium: { gasOriginExpectedUsd: 0.06, gasOriginMaxUsd: 0.12, expectedUsd: 0.17, maxUsd: 0.23 }, high: { gasOriginExpectedUsd: 0.09, gasOriginMaxUsd: 0.18, expectedUsd: 0.2, maxUsd: 0.29 } },
    },
    {
      order: 2, sourceNetwork: 'arbitrum', token: { symbol: 'ETH', decimals: 18, isNative: true }, amountRaw: '200400000000000000', amountUsd: 525,
      deliveryToken: { symbol: 'ETH', decimals: 18 }, receivedRaw: '200300000000000000', receivedUsd: 524.77, provider: 'across', carriesDestinationGas: true,
      alternative: { provider: 'lifi', costUsd: 1.53 },
      costs: { bridgeCostUsd: 0.23, bridgeFees: [{ name: 'Relayer (Across)', amountUsd: 0.23, included: true }], gasOrigin: { profilesMatter: false } },
      costsByProfile: { low: { gasOriginExpectedUsd: 0.03, gasOriginMaxUsd: 0.06, expectedUsd: 0.26, maxUsd: 0.29 }, medium: { gasOriginExpectedUsd: 0.05, gasOriginMaxUsd: 0.1, expectedUsd: 0.28, maxUsd: 0.33 }, high: { gasOriginExpectedUsd: 0.08, gasOriginMaxUsd: 0.16, expectedUsd: 0.31, maxUsd: 0.39 } },
    },
  ],
  deliveredUsd: 869.66,
  uncoveredUsd: 0,
  deployableUsd: 1000,
  costs: { byProfile: { low: byProfile(0.07, 0.09), medium: byProfile(0.11, 0.12), high: byProfile(0.17, 0.16) } },
};

async function setup(page, { activePlan }) {
  await page.addInitScript(({ token, user, wallet }) => {
    localStorage.setItem('hl_token', token);
    localStorage.setItem('hl_user', user);
    const listeners = {};
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet];
        if (method === 'eth_chainId') return '0xa4b1';
        if (method === 'net_version') return '42161';
        if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }];
        throw Object.assign(new Error(`método no soportado en el e2e: ${method}`), { code: 4200 });
      },
      on: (event, cb) => { (listeners[event] ||= []).push(cb); },
      removeListener: () => {},
    };
  }, { token: TOKEN, user: USER, wallet: WALLET });

  const discarded = [];
  await page.route('**/api/cross-chain/config', (route) => route.fulfill({ json: { success: true, data: { mode: 'execute' } } }));
  await page.route('**/api/cross-chain/funding-analysis', (route) => route.fulfill({ json: { success: true, data: ANALYSIS } }));
  await page.route('**/api/cross-chain/plans/active**', (route) => route.fulfill({ json: { success: true, data: activePlan } }));
  await page.route('**/api/cross-chain/plans/*/discard', (route) => {
    discarded.push(route.request().url());
    return route.fulfill({ json: { success: true, data: { ...PLAN, status: 'discarded' } } });
  });
  return { discarded };
}

async function openChooser(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '🎛 Orquestador LP' }).click();
  const connect = page.getByRole('button', { name: /Conectar con MetaMask/ });
  if (await connect.isVisible().catch(() => false)) await connect.click();
  await page.getByRole('button', { name: /Crear orquestador/ }).click();
  await expect(page.getByRole('dialog', { name: 'Nuevo orquestador' })).toBeVisible();
}

test.describe('Fondeo cross-chain — reanudar', () => {
  test.skip(!TOKEN || !USER, 'Requiere E2E_TOKEN y E2E_USER (sesión de desarrollo)');

  test('el selector avisa del plan en curso y lo retoma en su pool', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await setup(page, { activePlan: PLAN });
    await openChooser(page);

    const card = page.getByRole('region', { name: 'Tienes un plan de fondeo en curso' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('1 de 2 envíos entregados');
    await expect(card).toContainText('1 en camino');
    await expect(card).toContainText('Descartar no mueve fondos');

    await card.getByRole('button', { name: 'Continuar trayendo fondos' }).click();
    await expect(page.getByRole('dialog', { name: 'Nuevo LP orquestado' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('descartar el plan oculta el aviso', async ({ page }) => {
    const { discarded } = await setup(page, { activePlan: PLAN });
    await openChooser(page);
    const card = page.getByRole('region', { name: 'Tienes un plan de fondeo en curso' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole('button', { name: 'Descartar plan' }).click();
    await expect(card).toHaveCount(0);
    expect(discarded[0]).toMatch(/\/plans\/77\/discard$/);
  });

  test('sin plan en curso el selector se ve como siempre', async ({ page }) => {
    await setup(page, { activePlan: null });
    await openChooser(page);
    await expect(page.getByText('Crear un LP nuevo')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Tienes un plan de fondeo en curso' })).toHaveCount(0);
  });

  test('el paso Fondeo muestra los saldos de todas las redes, los perfiles y los costos', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await setup(page, { activePlan: PLAN });
    await openChooser(page);
    const card = page.getByRole('region', { name: 'Tienes un plan de fondeo en curso' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Retomar precarga Base / v4 / ETH-USDC y el capital; sin plan activo ya,
    // el paso Fondeo muestra el panel en vez de la ejecución.
    await page.unroute('**/api/cross-chain/plans/active**');
    await page.route('**/api/cross-chain/plans/active**', (route) => route.fulfill({ json: { success: true, data: null } }));
    await card.getByRole('button', { name: 'Continuar trayendo fondos' }).click();
    const wizard = page.getByRole('dialog', { name: 'Nuevo LP orquestado' });
    await expect(wizard).toBeVisible();
    await wizard.getByRole('button', { name: /Continuar a fondeo/ }).click({ timeout: 45_000 });

    await expect(wizard.getByRole('table', { name: 'Saldos en todas las redes' })).toBeVisible({ timeout: 45_000 });
    await expect(wizard.getByText('3.7 % > umbral 3 %')).toBeVisible();
    await expect(wizard.getByRole('button', { name: /Bajo/ })).toHaveAttribute('aria-pressed', 'true');
    await wizard.getByRole('button', { name: /Medio/ }).click();
    await expect(wizard.getByRole('heading', { name: /perfil medio/i })).toBeVisible();
    await expect(wizard.getByRole('button', { name: /Traer fondos \(2 envíos\)/ })).toBeEnabled();
    await wizard.getByRole('table', { name: 'Saldos en todas las redes' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.E2E_SCREENSHOT || 'test-results/cross-chain-funding.png', fullPage: false });
    expect(errors).toEqual([]);
  });
});

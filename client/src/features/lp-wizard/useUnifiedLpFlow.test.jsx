import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { lpOrchestratorApi } = vi.hoisted(() => ({
  lpOrchestratorApi: {
    preflightProtection: vi.fn(),
    createIntent: vi.fn(),
    commitIntent: vi.fn(),
  },
}));

const { smartCreateFlow } = vi.hoisted(() => ({
  smartCreateFlow: { current: null },
}));

vi.mock('../../services/api', () => ({
  lpOrchestratorApi,
  uniswapApi: {},
}));

vi.mock('../../pages/UniswapPools/components/smart-create/useSmartCreateFlow', () => ({
  default: () => smartCreateFlow.current,
}));

import useUnifiedLpFlow from './useUnifiedLpFlow';

// Par WETH/USDC en arbitrum. El backend devuelve los tokens resueltos en
// `suggestions.token0/token1`; el catálogo local vive en `tokenList`. Nótese
// que `tokenOptions` (lo que alimenta el <select>) solo tiene `label`/`value`:
// es exactamente por eso que buscar el símbolo ahí devolvía `undefined`.
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

function makeFlow(overrides = {}) {
  return {
    network: 'arbitrum',
    version: 'v4',
    token0Address: WETH,
    token1Address: USDC,
    fee: 500,
    totalUsdTarget: '100',
    tokenList: [
      { symbol: 'WETH', address: WETH, decimals: 18 },
      { symbol: 'USDC', address: USDC, decimals: 6 },
    ],
    tokenOptions: [
      { label: 'WETH (0x82aF…Bab1)', value: WETH },
      { label: 'USDC (0xaf88…5831)', value: USDC },
    ],
    suggestions: {
      token0: { symbol: 'WETH', address: WETH, decimals: 18 },
      token1: { symbol: 'USDC', address: USDC, decimals: 6 },
      currentPrice: 2200,
      pool: { priceCurrent: 2200 },
    },
    activeRange: { rangeLowerPrice: 2000, rangeUpperPrice: 2400 },
    prepareData: null,
    step: 'range',
    ...overrides,
  };
}

function renderFlow(flowOverrides = {}) {
  smartCreateFlow.current = makeFlow(flowOverrides);
  return renderHook(() => useUnifiedLpFlow({
    wallet: { address: '0x1111111111111111111111111111111111111111' },
    defaults: { network: 'arbitrum', version: 'v4' },
    initialMode: 'orchestrated',
  }));
}

describe('useUnifiedLpFlow — símbolos del par en el pre-flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lpOrchestratorApi.preflightProtection.mockResolvedValue({ ok: true, checks: [] });
  });

  it('manda token0Symbol y token1Symbol resueltos, no undefined', async () => {
    const { result } = renderFlow();

    await act(async () => {
      await result.current.runPreflight();
    });

    expect(lpOrchestratorApi.preflightProtection).toHaveBeenCalledTimes(1);
    const payload = lpOrchestratorApi.preflightProtection.mock.calls[0][0];
    expect(payload.token0Symbol).toBe('WETH');
    expect(payload.token1Symbol).toBe('USDC');
  });

  it('resuelve el símbolo aunque el backend devuelva el par en orden de pool', async () => {
    // `requestedTokenOrderReversed`: el backend puede devolver token0/token1
    // en orden de pool, que no tiene por qué ser el que eligió el usuario.
    // Por eso se busca por address y no por índice.
    const { result } = renderFlow({
      suggestions: {
        token0: { symbol: 'USDC', address: USDC, decimals: 6 },
        token1: { symbol: 'WETH', address: WETH, decimals: 18 },
        requestedTokenOrderReversed: true,
        pool: { priceCurrent: 2200 },
      },
    });

    await act(async () => {
      await result.current.runPreflight();
    });

    const payload = lpOrchestratorApi.preflightProtection.mock.calls[0][0];
    expect(payload.token0Symbol).toBe('WETH');
    expect(payload.token1Symbol).toBe('USDC');
  });

  it('cae al catálogo local cuando todavía no hay suggestions', async () => {
    const { result } = renderFlow({ suggestions: null });

    await act(async () => {
      await result.current.runPreflight();
    });

    const payload = lpOrchestratorApi.preflightProtection.mock.calls[0][0];
    expect(payload.token0Symbol).toBe('WETH');
    expect(payload.token1Symbol).toBe('USDC');
  });

  it('resuelve una address pegada a mano que no está en el catálogo local', async () => {
    const CUSTOM = '0x912CE59144191C1204E64559FE8253a0e49E6548';
    const { result } = renderFlow({
      token0Address: CUSTOM,
      suggestions: {
        token0: { symbol: 'ARB', address: CUSTOM, decimals: 18 },
        token1: { symbol: 'USDC', address: USDC, decimals: 6 },
        pool: { priceCurrent: 0.4 },
      },
    });

    await act(async () => {
      await result.current.runPreflight();
    });

    const payload = lpOrchestratorApi.preflightProtection.mock.calls[0][0];
    expect(payload.token0Symbol).toBe('ARB');
    expect(payload.token1Symbol).toBe('USDC');
  });

  it('resuelve ETH nativo de v4, que es address(0) y no está en el catálogo', async () => {
    // En v4 el ETH nativo es una currency válida con address(0); el catálogo
    // local solo tiene WETH en su address real, así que este caso SOLO se
    // resuelve por `suggestions`. Es la razón de que sea la fuente preferente.
    const NATIVE = '0x0000000000000000000000000000000000000000';
    const { result } = renderFlow({
      token0Address: NATIVE,
      suggestions: {
        token0: { symbol: 'ETH', address: NATIVE, decimals: 18, isNative: true },
        token1: { symbol: 'USDC', address: USDC, decimals: 6 },
        pool: { priceCurrent: 2200 },
      },
    });

    await act(async () => {
      await result.current.runPreflight();
    });

    const payload = lpOrchestratorApi.preflightProtection.mock.calls[0][0];
    expect(payload.token0Symbol).toBe('ETH');
    expect(payload.token1Symbol).toBe('USDC');
  });

  it('compara addresses sin distinguir mayúsculas', async () => {
    const { result } = renderFlow({ token0Address: WETH.toLowerCase() });

    await act(async () => {
      await result.current.runPreflight();
    });

    const payload = lpOrchestratorApi.preflightProtection.mock.calls[0][0];
    expect(payload.token0Symbol).toBe('WETH');
  });
});

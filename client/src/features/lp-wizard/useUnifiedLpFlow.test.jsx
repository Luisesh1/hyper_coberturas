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
  default: (args) => {
    // Se guardan los args para poder disparar `onFinalized`, que es como el
    // flujo base avisa de que la posición ya está on-chain.
    smartCreateFlow.args = args;
    return smartCreateFlow.current;
  },
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
    rangeMode: 'preset',
    setRangeMode: vi.fn(),
    setCustomLowerPrice: vi.fn(),
    setCustomUpperPrice: vi.fn(),
    setCustomWeightToken0: vi.fn(),
    handleContinueToFunding: vi.fn(),
    prepareData: null,
    handleExecute: vi.fn(),
    step: 'range',
    ...overrides,
  };
}

function renderFlow(flowOverrides = {}) {
  smartCreateFlow.current = makeFlow(flowOverrides);
  const view = renderHook(() => useUnifiedLpFlow({
    wallet: { address: '0x1111111111111111111111111111111111111111' },
    defaults: { network: 'arbitrum', version: 'v4' },
    initialMode: 'orchestrated',
  }));
  act(() => {
    view.result.current.setProtection({
      ...view.result.current.protection,
      accountId: 1,
    });
  });
  return view;
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

  it('manda currentPrice en el plan de intención', async () => {
    lpOrchestratorApi.createIntent.mockResolvedValue({ operationKey: 'op-1' });
    const { result } = renderFlow();

    await act(async () => {
      await result.current.handleSignAndCreate();
    });

    expect(lpOrchestratorApi.createIntent).toHaveBeenCalledTimes(1);
    const plan = lpOrchestratorApi.createIntent.mock.calls[0][0];
    expect(plan.priceCurrent).toBe(2200);
    expect(plan.rangeLowerPrice).toBe(2000);
    expect(plan.rangeUpperPrice).toBe(2400);
  });
});

// El orquestador que se quedó sin LP abre el wizard en standalone y luego
// adjunta la posición con attach-lp. Para eso necesita el finalize completo:
// devolver sólo `{ status: 'completed' }` dejaba el LP on-chain y al caller
// sin forma de identificar qué posición vincular.
describe('useUnifiedLpFlow — standalone entrega el finalize al caller', () => {
  const FINALIZE = {
    positionChanges: { newPositionIdentifier: '98765' },
    refreshedSnapshot: { some: 'snapshot' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    smartCreateFlow.current = makeFlow();
    smartCreateFlow.args = null;
  });

  function renderStandalone(onCompleted) {
    return renderHook(() => useUnifiedLpFlow({
      mode: 'standalone',
      wallet: { address: '0x1111111111111111111111111111111111111111' },
      defaults: { network: 'arbitrum', version: 'v4' },
      onCompleted,
    }));
  }

  it('propaga finalizeResult y txHashes', async () => {
    const onCompleted = vi.fn();
    renderStandalone(onCompleted);

    await act(async () => {
      await smartCreateFlow.args.onFinalized({ finalizeResult: FINALIZE, txHashes: ['0xaaa'] });
    });

    expect(onCompleted).toHaveBeenCalledTimes(1);
    const payload = onCompleted.mock.calls[0][0];
    expect(payload.status).toBe('completed');
    expect(payload.finalizeResult.positionChanges.newPositionIdentifier).toBe('98765');
    expect(payload.txHashes).toEqual(['0xaaa']);
  });

  it('acepta el finalize plano, sin envolver', async () => {
    const onCompleted = vi.fn();
    renderStandalone(onCompleted);

    await act(async () => {
      await smartCreateFlow.args.onFinalized({ ...FINALIZE, txHashes: ['0xbbb'] });
    });

    const payload = onCompleted.mock.calls[0][0];
    expect(payload.finalizeResult.positionChanges.newPositionIdentifier).toBe('98765');
    expect(payload.txHashes).toEqual(['0xbbb']);
  });

  it('no llama a la saga de creación: el orquestador ya existe', async () => {
    renderStandalone(vi.fn());

    await act(async () => {
      await smartCreateFlow.args.onFinalized({ finalizeResult: FINALIZE, txHashes: [] });
    });

    expect(lpOrchestratorApi.createIntent).not.toHaveBeenCalled();
    expect(lpOrchestratorApi.commitIntent).not.toHaveBeenCalled();
  });
});

// Regresión de un caso real: fallo una tx al crear un orquestador, el usuario
// reintento, y el reintento fue directo de `prepare` a `create-intent` sin
// pasar por `preflight-protection`. `protectionDone` seguia en true tras el
// reset, asi que el wizard se saltaba el paso de cobertura entero y firmaba
// con un pre-flight que habia validado el plan ANTERIOR.
describe('useUnifiedLpFlow — reintento tras un fallo de firma', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lpOrchestratorApi.preflightProtection.mockResolvedValue({ ok: true, checks: [] });
    lpOrchestratorApi.createIntent.mockResolvedValue({ operationKey: 'op-1' });
  });

  async function llegarARevision() {
    smartCreateFlow.current = makeFlow({ step: 'review', handleReset: vi.fn() });
    const view = renderHook(() => useUnifiedLpFlow({
      mode: 'orchestrated',
      wallet: { address: '0x1111111111111111111111111111111111111111' },
      defaults: { network: 'arbitrum', version: 'v4' },
    }));
    act(() => {
      view.result.current.setProtection({
        ...view.result.current.protection,
        accountId: 1,
      });
    });
    // Con el paso de cobertura sin superar, REVIEW se intercepta con PROTECTION.
    expect(view.result.current.step).toBe('protection');
    await act(async () => {
      await view.result.current.handleContinueFromProtection();
    });
    expect(view.result.current.step).toBe('review');
    return view;
  }

  it('vuelve a exigir el paso de cobertura', async () => {
    const view = await llegarARevision();

    act(() => { view.result.current.handleReset(); });

    expect(view.result.current.step).toBe('protection');
  });

  it('limpia el pre-flight validado del intento anterior', async () => {
    const view = await llegarARevision();
    expect(view.result.current.preflight).toEqual({ ok: true, checks: [] });

    act(() => { view.result.current.handleReset(); });

    expect(view.result.current.preflight).toBe(null);
  });

  it('resetea también el flujo base', async () => {
    const view = await llegarARevision();

    act(() => { view.result.current.handleReset(); });

    expect(smartCreateFlow.current.handleReset).toHaveBeenCalledTimes(1);
  });

  it('el reintento registra una intención nueva, no reusa la abandonada', async () => {
    const view = await llegarARevision();
    await act(async () => { await view.result.current.handleSignAndCreate(); });
    expect(lpOrchestratorApi.createIntent).toHaveBeenCalledTimes(1);

    act(() => { view.result.current.handleReset(); });
    act(() => {
      view.result.current.setProtection({
        ...view.result.current.protection,
        accountId: 1,
      });
    });
    await act(async () => {
      await view.result.current.handleContinueFromProtection();
    });
    lpOrchestratorApi.createIntent.mockResolvedValue({ operationKey: 'op-2' });
    await act(async () => { await view.result.current.handleSignAndCreate(); });

    // Dos intenciones distintas: la abandonada caduca sola por TTL en el
    // servidor, pero jamás se firma contra ella.
    expect(lpOrchestratorApi.createIntent).toHaveBeenCalledTimes(2);
  });
});

describe('useUnifiedLpFlow — defaults y validación de cobertura', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    smartCreateFlow.current = makeFlow();
    lpOrchestratorApi.preflightProtection.mockResolvedValue({ ok: true, checks: [] });
  });

  it('activa adaptive con leverage 10 en un wizard orquestado', () => {
    const { result } = renderHook(() => useUnifiedLpFlow({
      mode: 'orchestrated',
      wallet: { address: '0x1111111111111111111111111111111111111111' },
      defaults: { network: 'arbitrum', version: 'v4', totalUsdTarget: 1000 },
    }));

    expect(result.current.protection.enabled).toBe(true);
    expect(result.current.protection.preset).toBe('adaptive');
    expect(result.current.protection.bandMode).toBe('adaptive');
    expect(result.current.protection.leverage).toBe('10');
  });

  it('no llama al backend si la cuenta Hyperliquid está vacía', async () => {
    const { result } = renderHook(() => useUnifiedLpFlow({
      mode: 'orchestrated',
      wallet: { address: '0x1111111111111111111111111111111111111111' },
      defaults: { network: 'arbitrum', version: 'v4', totalUsdTarget: 1000 },
    }));

    let response;
    await act(async () => {
      response = await result.current.handleContinueFromProtection();
    });

    expect(response.ok).toBe(false);
    expect(response.blockingReason).toMatch(/cuenta de Hyperliquid/i);
    expect(lpOrchestratorApi.preflightProtection).not.toHaveBeenCalled();
  });

  it('al cambiar la wallet limpia la intención y reinicia el flujo base', () => {
    const flowReset = vi.fn();
    smartCreateFlow.current = makeFlow({ step: 'review', handleReset: flowReset });
    const view = renderHook(
      ({ address }) => useUnifiedLpFlow({
        mode: 'orchestrated',
        wallet: { address },
        defaults: { network: 'arbitrum', version: 'v4', totalUsdTarget: 1000 },
      }),
      { initialProps: { address: '0x1111111111111111111111111111111111111111' } }
    );

    act(() => {
      view.rerender({ address: '0x2222222222222222222222222222222222222222' });
    });

    expect(flowReset).toHaveBeenCalledTimes(1);
    expect(view.result.current.preflight).toBe(null);
    expect(view.result.current.protection.enabled).toBe(true);
  });
});

describe('useUnifiedLpFlow — rango ATR ETH/USDC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aplica la recomendación ATR como rango custom y exige confirmación si supera 20%', () => {
    const setRangeMode = vi.fn();
    const setCustomLowerPrice = vi.fn();
    const setCustomUpperPrice = vi.fn();
    const handleContinueToFunding = vi.fn();
    const { result } = renderFlow({
      setRangeMode,
      setCustomLowerPrice,
      setCustomUpperPrice,
      handleContinueToFunding,
      suggestions: {
        token0: { symbol: 'WETH', address: WETH, decimals: 18 },
        token1: { symbol: 'USDC', address: USDC, decimals: 6 },
        currentPrice: 2000,
        atr14: 100,
        ethUsdcRangeRecommendation: {
          halfWidthPct: 15,
          widthPct: 30,
          source: 'max_4_2pct_or_3atr',
          requiresConfirmation: true,
        },
      },
    });

    expect(result.current.ethUsdcRangeRecommendation.halfWidthPct).toBe(15);
    act(() => result.current.applyEthUsdcRangeRecommendation());
    expect(setRangeMode).toHaveBeenCalledWith('custom');
    expect(setCustomLowerPrice).toHaveBeenCalledWith('1700');
    expect(setCustomUpperPrice).toHaveBeenCalledWith('2300');
    expect(result.current.handleContinueFromRange()).toEqual({ ok: false, requiresConfirmation: true });
    expect(handleContinueToFunding).not.toHaveBeenCalled();

    act(() => result.current.setEthUsdcRangeConfirmed(true));
    expect(result.current.handleContinueFromRange()).toEqual({ ok: true });
    expect(handleContinueToFunding).toHaveBeenCalledTimes(1);
  });

  it('no expone la recomendación ATR en standalone ni para otros pares', () => {
    const standalone = renderHook(() => useUnifiedLpFlow({
      mode: 'standalone',
      wallet: { address: '0x1111111111111111111111111111111111111111' },
      defaults: { network: 'arbitrum', version: 'v4' },
    }));
    expect(standalone.result.current.ethUsdcRangeRecommendation).toBe(null);

    const otherPair = renderFlow({
      token0Address: USDC,
      token1Address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
      tokenList: [
        { symbol: 'USDC', address: USDC, decimals: 6 },
        { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
      ],
      suggestions: {
        token0: { symbol: 'USDC', address: USDC, decimals: 6 },
        token1: { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
        currentPrice: 1,
        ethUsdcRangeRecommendation: { halfWidthPct: 15, widthPct: 30, requiresConfirmation: true },
      },
    });
    expect(otherPair.result.current.ethUsdcRangeRecommendation).toBe(null);
  });

  it('recomienda sombra para ETH/USDC sin reemplazar una elección legacy explícita', () => {
    const { result } = renderFlow();
    expect(result.current.protection.policyVersion).toBe('net_profit_v1');
    expect(result.current.protection.executionIntent).toBe('shadow');

    act(() => result.current.setProtection({
      ...result.current.protection,
      policyVersion: 'legacy_zones_v1',
      executionIntent: 'live',
      activationConfirmed: false,
    }));
    expect(result.current.buildPlan().protection.policyVersion).toBe('legacy_zones_v1');
  });
});

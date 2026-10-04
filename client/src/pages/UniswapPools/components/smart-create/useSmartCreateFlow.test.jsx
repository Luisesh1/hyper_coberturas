import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { uniswapApi } = vi.hoisted(() => ({
  uniswapApi: {
    getSmartCreateTokenList: vi.fn(),
    getSmartCreateAssets: vi.fn(),
    smartCreateSuggest: vi.fn(),
    smartCreateFundingPlan: vi.fn(),
    prepareCreatePosition: vi.fn(),
  },
}));

vi.mock('../../../../services/api', () => ({ uniswapApi }));

// La referencia tiene que ser ESTABLE entre renders: hay efectos que dependen
// de `execution.txHashes`, y devolver un objeto nuevo cada vez los reejecuta en
// bucle hasta agotar la memoria.
const EXECUTION = {
  state: 'idle',
  txHashes: [],
  progress: { completed: 0 },
  currentTx: null,
  normalizedError: null,
  reset: () => {},
};

vi.mock('../../../../hooks/useWalletExecution', () => ({
  WALLET_EXECUTION_STATE: { IDLE: 'idle', PREFLIGHT: 'preflight', AWAITING_WALLET: 'awaiting' },
  useWalletExecution: () => EXECUTION,
}));

import useSmartCreateFlow from './useSmartCreateFlow';

const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const NATIVE = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const CATALOGO_V3 = [
  { symbol: 'WETH', address: WETH, decimals: 18, isWrappedNative: true },
  { symbol: 'USDC', address: USDC, decimals: 6 },
];
const CATALOGO_V4 = [
  { symbol: 'ETH', address: NATIVE, decimals: 18, isNative: true },
  { symbol: 'USDC', address: USDC, decimals: 6 },
];

function render(defaults, wallet = { address: '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde' }, v4DynamicFeeHook = null) {
  return renderHook(
    (props) => useSmartCreateFlow({ wallet, defaults: props, v4DynamicFeeHook, onFinalized: vi.fn() }),
    { initialProps: defaults }
  );
}

function renderWithWallet(defaults, wallet) {
  return renderHook(
    ({ currentWallet, currentDefaults }) => useSmartCreateFlow({
      wallet: currentWallet,
      defaults: currentDefaults,
      onFinalized: vi.fn(),
    }),
    { initialProps: { currentWallet: wallet, currentDefaults: defaults } }
  );
}

describe('catálogo de tokens por versión', () => {
  beforeEach(() => {
    uniswapApi.getSmartCreateTokenList.mockReset();
    uniswapApi.getSmartCreateAssets.mockReset();
    uniswapApi.smartCreateSuggest.mockReset();
    uniswapApi.getSmartCreateTokenList.mockImplementation(async (_network, version) => (
      version === 'v4' ? CATALOGO_V4 : CATALOGO_V3
    ));
    uniswapApi.getSmartCreateAssets.mockResolvedValue({
      assets: [
        { id: 'native', symbol: 'ETH', usableBalance: '0.498', usdPrice: 2500 },
        { id: 'usdc', symbol: 'USDC', usableBalance: '1200', usdPrice: 1 },
        { id: 'unknown', symbol: 'UNKNOWN', usableBalance: '100', usdPrice: null },
      ],
    });
    uniswapApi.smartCreateSuggest.mockResolvedValue({
      currentPrice: 2500,
      suggestions: [],
    });
  });

  it('pide el catálogo de la versión seleccionada', async () => {
    render({ network: 'arbitrum', version: 'v4' });
    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalled());
    expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalledWith('arbitrum', 'v4');
  });

  // En v4 el ETH es una currency de primera clase: ofrecer WETH parte la
  // liquidez y obliga a un wrap que el pool no necesita.
  it('en v4 se ofrece ETH y no WETH', async () => {
    const { result } = render({ network: 'arbitrum', version: 'v4' });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));

    const etiquetas = result.current.tokenOptions.map((o) => o.label);
    expect(etiquetas.some((l) => l.startsWith('WETH'))).toBe(false);
    expect(etiquetas).toContain('ETH (nativo)');
  });

  it('en v3 se sigue ofreciendo WETH', async () => {
    const { result } = render({ network: 'arbitrum', version: 'v3' });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    expect(result.current.tokenOptions.some((o) => o.label.startsWith('WETH'))).toBe(true);
  });

  // address(0) en el desplegable se lee como la dirección de quema; el nativo
  // se etiqueta por lo que es.
  it('el nativo no muestra 0x0000…0000', async () => {
    const { result } = render({ network: 'arbitrum', version: 'v4' });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    const eth = result.current.tokenOptions.find((o) => o.value === NATIVE);
    expect(eth.label).toBe('ETH (nativo)');
    expect(eth.label).not.toContain('0x0000');
  });

  it('recarga el catálogo al cambiar de versión', async () => {
    const { rerender } = render({ network: 'arbitrum', version: 'v3' });
    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalledWith('arbitrum', 'v3'));

    rerender({ network: 'arbitrum', version: 'v4' });
    await waitFor(() => expect(uniswapApi.getSmartCreateTokenList).toHaveBeenCalledWith('arbitrum', 'v4'));
  });

  // Sin esto el <select> se veía vacío pero el análisis seguía recibiendo la
  // address de WETH, que en v4 ya no se ofrece.
  it('suelta el par elegido al cambiar de versión', async () => {
    const { result, rerender } = render({
      network: 'arbitrum', version: 'v3', token0Address: WETH, token1Address: USDC,
    });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    expect(result.current.token0Address).toBe(WETH);

    rerender({ network: 'arbitrum', version: 'v4', token0Address: WETH, token1Address: USDC });
    await waitFor(() => expect(result.current.token0Address).toBe(''));
    expect(result.current.token1Address).toBe(USDC);
  });

  it('respeta el par que llega en defaults al montar', async () => {
    const { result } = render({
      network: 'arbitrum', version: 'v4', token0Address: NATIVE, token1Address: USDC,
    });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    expect(result.current.token0Address).toBe(NATIVE);
    expect(result.current.token1Address).toBe(USDC);
  });

  it('conserva la identidad del hook verificado durante el análisis V4', async () => {
    const { result } = render({
      network: 'arbitrum', version: 'v4', token0Address: NATIVE, token1Address: USDC, totalUsdTarget: '100',
    }, undefined, {
      address: '0x0000000000000000000000000000000000000080',
      tickSpacing: 60,
    });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));

    await act(async () => { await result.current.handleAnalyzePool(); });

    expect(uniswapApi.smartCreateSuggest).toHaveBeenCalledWith(expect.objectContaining({
      hooks: '0x0000000000000000000000000000000000000080',
      tickSpacing: 60,
    }));
  });
});

describe('defaults iniciales desde la wallet', () => {
  beforeEach(() => {
    uniswapApi.getSmartCreateTokenList.mockReset();
    uniswapApi.getSmartCreateAssets.mockReset();
    uniswapApi.smartCreateSuggest.mockReset();
    uniswapApi.getSmartCreateTokenList.mockImplementation(async (_network, version) => (
      version === 'v4' ? CATALOGO_V4 : CATALOGO_V3
    ));
    uniswapApi.getSmartCreateAssets.mockResolvedValue({
      assets: [
        { id: 'native', symbol: 'ETH', usableBalance: '0.498', usdPrice: 2500 },
        { id: 'usdc', symbol: 'USDC', usableBalance: '1200', usdPrice: 1 },
      ],
    });
    uniswapApi.smartCreateSuggest.mockResolvedValue({
      currentPrice: 2500,
      suggestions: [{ preset: 'balanced', rangeLowerPrice: 2000, rangeUpperPrice: 3000, targetWeightToken0Pct: 50 }],
    });
  });

  it('calcula el objetivo con saldo utilizable, precios y margen del 5%', async () => {
    const { result } = render({ network: 'arbitrum', version: 'v3' });

    await waitFor(() => expect(result.current.totalUsdTarget).toBe('2322.75'));
    expect(uniswapApi.getSmartCreateAssets).toHaveBeenCalledWith({
      network: 'arbitrum',
      walletAddress: '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde',
    });
  });

  it('prefiere ETH a WETH aunque el catálogo venga en otro orden', async () => {
    const { result } = render({ network: 'arbitrum', version: 'v4' });

    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    expect(result.current.token0Address).toBe(NATIVE);
    expect(result.current.token1Address).toBe(USDC);
  });

  it('selecciona USDG al crear un pool v4 en Robinhood', async () => {
    uniswapApi.getSmartCreateTokenList.mockResolvedValue([
      { symbol: 'ETH', address: NATIVE, decimals: 18, isNative: true },
      { symbol: 'USDG', address: USDG, decimals: 6 },
    ]);
    const { result } = render({ network: 'robinhood', version: 'v4' });

    await waitFor(() => expect(result.current.token1Address).toBe(USDG));
    expect(result.current.token0Address).toBe(NATIVE);
  });

  it('prioriza defaults explícitos y no consulta el objetivo automático', async () => {
    const { result } = render({
      network: 'arbitrum',
      version: 'v3',
      totalUsdTarget: '77',
      token0Address: WETH,
      token1Address: USDC,
    });

    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    expect(result.current.totalUsdTarget).toBe('77');
    expect(result.current.token0Address).toBe(WETH);
    expect(uniswapApi.getSmartCreateAssets).not.toHaveBeenCalled();
  });

  it('no sobrescribe un objetivo editado mientras carga los activos', async () => {
    let resolveAssets;
    uniswapApi.getSmartCreateAssets.mockImplementation(() => new Promise((resolve) => {
      resolveAssets = resolve;
    }));
    const { result } = render({ network: 'arbitrum', version: 'v3' });

    act(() => { result.current.setTotalUsdTarget('321'); });
    await act(async () => {
      resolveAssets({ assets: [{ usableBalance: '999', usdPrice: 10 }] });
    });

    expect(result.current.totalUsdTarget).toBe('321');
  });

  it('reinicia el análisis y solicita el objetivo para la nueva wallet', async () => {
    const defaults = { network: 'arbitrum', version: 'v4' };
    const wallet1 = { address: '0x1111111111111111111111111111111111111111' };
    const wallet2 = { address: '0x2222222222222222222222222222222222222222' };
    const { result, rerender } = renderWithWallet(defaults, wallet1);

    await waitFor(() => expect(result.current.token0Address).toBe(NATIVE));
    await waitFor(() => expect(result.current.totalUsdTarget).toBe('2322.75'));
    await act(async () => { await result.current.handleAnalyzePool(); });
    await waitFor(() => expect(result.current.step).toBe('range'));

    rerender({ currentWallet: wallet2, currentDefaults: defaults });
    await waitFor(() => expect(result.current.step).toBe('pool'));
    expect(uniswapApi.getSmartCreateAssets).toHaveBeenLastCalledWith({
      network: 'arbitrum',
      walletAddress: wallet2.address,
    });
    expect(result.current.suggestions).toBe(null);
  });
});

// Primera creación real en Robinhood (2026-10-03): tras un fallo había que
// reconfigurar todo; al reiniciar el capital se quedaba con el valor viejo.
describe('reintento y reinicio del flujo base', () => {
  beforeEach(() => {
    for (const fn of Object.values(uniswapApi)) fn.mockReset();
    uniswapApi.getSmartCreateTokenList.mockImplementation(async (_network, version) => (
      version === 'v4' ? CATALOGO_V4 : CATALOGO_V3
    ));
    uniswapApi.getSmartCreateAssets.mockResolvedValue({
      assets: [
        { id: 'native', symbol: 'ETH', usableBalance: '0.498', usdPrice: 2500 },
        { id: 'usdc', symbol: 'USDC', usableBalance: '1200', usdPrice: 1 },
      ],
    });
    uniswapApi.smartCreateSuggest.mockResolvedValue({
      currentPrice: 2500,
      suggestions: [{ preset: 'balanced', rangeLowerPrice: 2000, rangeUpperPrice: 3000, targetWeightToken0Pct: 50 }],
    });
  });

  it('empezar de nuevo recalcula el capital con el saldo actual', async () => {
    const { result } = render({ network: 'arbitrum', version: 'v3' });
    await waitFor(() => expect(result.current.totalUsdTarget).toBe('2322.75'));
    act(() => { result.current.setTotalUsdTarget('321'); });
    uniswapApi.getSmartCreateAssets.mockResolvedValue({
      assets: [{ id: 'usdc', symbol: 'USDC', usableBalance: '100', usdPrice: 1 }],
    });

    act(() => { result.current.handleReset(); });

    await waitFor(() => expect(result.current.totalUsdTarget).toBe('95'));
    expect(result.current.step).toBe('pool');
  });

  it('reintentar desde la cadena rehace fondeo y prepare y deja al usuario en Revisión', async () => {
    const plan = {
      selectedFundingAssets: [{ assetId: 'usdc', useAmount: '251' }, { assetId: 'weth', useAmount: '0.0927' }],
      availableFundingAssets: [],
    };
    uniswapApi.smartCreateFundingPlan.mockResolvedValue(plan);
    uniswapApi.prepareCreatePosition.mockResolvedValue({ txPlan: [{ label: 'Create position (v4)' }] });
    const { result } = render({
      network: 'arbitrum', version: 'v3', token0Address: WETH, token1Address: USDC, totalUsdTarget: '500',
    });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    await act(async () => { await result.current.handleAnalyzePool(); });

    let ok;
    await act(async () => { ok = await result.current.retryFromChain(); });

    expect(ok).toBe(true);
    expect(result.current.step).toBe('review');
    expect(result.current.totalUsdTarget).toBe('500');
    const prepareArgs = uniswapApi.prepareCreatePosition.mock.calls[0][0];
    expect(prepareArgs.totalUsdTarget).toBe(500);
    expect(prepareArgs.fundingSelections).toEqual([
      { assetId: 'usdc', amount: '251', enabled: true },
      { assetId: 'weth', amount: '0.0927', enabled: true },
    ]);
  });

  it('si el recálculo del fondeo falla se queda en Fondeo con el problema', async () => {
    uniswapApi.smartCreateFundingPlan.mockRejectedValue(new Error('saldo insuficiente'));
    const { result } = render({
      network: 'arbitrum', version: 'v3', token0Address: WETH, token1Address: USDC, totalUsdTarget: '500',
    });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    await act(async () => { await result.current.handleAnalyzePool(); });

    let ok;
    await act(async () => { ok = await result.current.retryFromChain(); });

    expect(ok).toBe(false);
    expect(result.current.step).toBe('funding');
    expect(uniswapApi.prepareCreatePosition).not.toHaveBeenCalled();
  });
});

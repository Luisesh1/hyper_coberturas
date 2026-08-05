import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { uniswapApi } = vi.hoisted(() => ({
  uniswapApi: { getSmartCreateTokenList: vi.fn() },
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

const CATALOGO_V3 = [
  { symbol: 'WETH', address: WETH, decimals: 18, isWrappedNative: true },
  { symbol: 'USDC', address: USDC, decimals: 6 },
];
const CATALOGO_V4 = [
  { symbol: 'ETH', address: NATIVE, decimals: 18, isNative: true },
  { symbol: 'USDC', address: USDC, decimals: 6 },
];

function render(defaults) {
  return renderHook(
    (props) => useSmartCreateFlow({ wallet: { address: '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde' }, defaults: props, onFinalized: vi.fn() }),
    { initialProps: defaults }
  );
}

describe('catálogo de tokens por versión', () => {
  beforeEach(() => {
    uniswapApi.getSmartCreateTokenList.mockReset();
    uniswapApi.getSmartCreateTokenList.mockImplementation(async (_network, version) => (
      version === 'v4' ? CATALOGO_V4 : CATALOGO_V3
    ));
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
    expect(result.current.token1Address).toBe('');
  });

  it('respeta el par que llega en defaults al montar', async () => {
    const { result } = render({
      network: 'arbitrum', version: 'v4', token0Address: NATIVE, token1Address: USDC,
    });
    await waitFor(() => expect(result.current.tokenOptions.length).toBe(2));
    expect(result.current.token0Address).toBe(NATIVE);
    expect(result.current.token1Address).toBe(USDC);
  });
});

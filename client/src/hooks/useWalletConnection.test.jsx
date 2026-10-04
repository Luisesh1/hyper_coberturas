import { describe, expect, it, vi } from 'vitest';
import { buildTransactionParams, extractTxHash, sendWalletTransaction, waitForBroadcastedHash } from './useWalletConnection';

describe('useWalletConnection helpers', () => {
  it('omite gas cuando se solicita explícitamente', () => {
    const txParams = buildTransactionParams({
      address: '0x00000000000000000000000000000000000000ff',
      tx: {
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: '0x0',
        gas: '0x55730',
      },
      includeGas: false,
    });

    expect(txParams).toEqual({
      from: '0x00000000000000000000000000000000000000ff',
      to: '0x00000000000000000000000000000000000000aa',
      data: '0x1234',
      value: '0x0',
    });
  });

  it('preserva hashes ambiguos como broadcast_unknown para seguir monitoreando la red', async () => {
    const provider = {
      request: vi.fn()
        .mockRejectedValueOnce({ data: { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111' } })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    };
    const setError = vi.fn();

    const hash = await sendWalletTransaction({
      provider,
      address: '0x00000000000000000000000000000000000000ff',
      chainId: 42161,
      tx: {
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: '0x0',
      },
      switchChain: vi.fn(),
      setError,
    });

    expect(hash).toBe('0x1111111111111111111111111111111111111111111111111111111111111111');
    expect(setError).toHaveBeenLastCalledWith('La wallet devolvió un estado ambiguo, pero la transacción podría haberse enviado.');
  });

  it('no reintenta automáticamente si el wallet rechaza el envío con gas explícito', async () => {
    const provider = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error('gas too low'))
        .mockResolvedValueOnce('0x2222222222222222222222222222222222222222222222222222222222222222'),
    };

    const setError = vi.fn();
    const hash = await sendWalletTransaction({
      provider,
      address: '0x00000000000000000000000000000000000000ff',
      chainId: 42161,
      tx: {
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: '0x0',
        gas: '0x55730',
      },
      switchChain: vi.fn(),
      setError,
    });

    expect(hash).toBeNull();
    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(provider.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'eth_sendTransaction',
      params: [expect.objectContaining({ gas: '0x55730' })],
    }));
    expect(setError).toHaveBeenCalledWith('gas too low');
  });

  it('extrae un hash anidado de una respuesta exitosa del wallet', async () => {
    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce({
          result: {
            data: {
              transactionHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
            },
          },
        }),
    };

    const hash = await sendWalletTransaction({
      provider,
      address: '0x00000000000000000000000000000000000000ff',
      chainId: 42161,
      tx: {
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: '0x0',
      },
      switchChain: vi.fn(),
      setError: vi.fn(),
    });

    expect(hash).toBe('0x5555555555555555555555555555555555555555555555555555555555555555');
  });

  it('estima gas para mint y envía con el gas calculado', async () => {
    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce('0x5208')
        .mockResolvedValueOnce('0x6666666666666666666666666666666666666666666666666666666666666666'),
    };

    const hash = await sendWalletTransaction({
      provider,
      address: '0x00000000000000000000000000000000000000ff',
      chainId: 42161,
      tx: {
        kind: 'mint_position',
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: '0x0',
        gas: '0x55730',
      },
      switchChain: vi.fn(),
      setError: vi.fn(),
    });

    expect(hash).toBe('0x6666666666666666666666666666666666666666666666666666666666666666');
    expect(provider.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'eth_estimateGas',
      params: [expect.objectContaining({
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
      })],
    }));
    expect(provider.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'eth_sendTransaction',
      params: [expect.objectContaining({
        gas: '0x6270',
      })],
    }));
  });

  it('confirma cuando un hash sí existe en la red', async () => {
    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ hash: '0x3333333333333333333333333333333333333333333333333333333333333333' }),
    };

    const found = await waitForBroadcastedHash(provider, '0x3333333333333333333333333333333333333333333333333333333333333333', {
      attempts: 2,
      pollMs: 1,
    });

    expect(found).toBe(true);
  });

  it('extrae hashes profundos dentro de errores compuestos', () => {
    const hash = extractTxHash({
      error: {
        data: {
          transactionHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
        },
      },
    });

    expect(hash).toBe('0x4444444444444444444444444444444444444444444444444444444444444444');
  });
});

// En desarrollo StrictMode ejecutaba dos veces el useMemo del provider: dos
// configs de wagmi con dos conectores de WalletConnect y dos Cores sobre la
// misma sesión ("Init() was called 2 times"). Las respuestas de la wallet
// (hash o rechazo) se perdían y el flujo de firma quedaba colgado.
describe('getWagmiConfig', () => {
  it('reutiliza la misma config para el mismo projectId', async () => {
    const { getWagmiConfig } = await import('./useWalletConnection');
    expect(getWagmiConfig('proj-a')).toBe(getWagmiConfig('proj-a'));
    expect(getWagmiConfig('')).toBe(getWagmiConfig(''));
  });

  it('crea una config distinta si cambia el projectId', async () => {
    const { getWagmiConfig } = await import('./useWalletConnection');
    expect(getWagmiConfig('proj-a')).not.toBe(getWagmiConfig('proj-b'));
  });
});

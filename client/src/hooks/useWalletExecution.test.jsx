import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWalletExecution, WALLET_EXECUTION_STATE } from './useWalletExecution';

const { uniswapApi } = vi.hoisted(() => ({
  uniswapApi: {
    finalizePositionAction: vi.fn(),
    finalizeClaimFees: vi.fn(),
    getOperation: vi.fn(),
  },
}));

const walletMock = vi.hoisted(() => ({
  isConnected: true,
  address: '0x00000000000000000000000000000000000000ff',
  chainId: 42161,
  preflightTransaction: vi.fn(),
  submitTransactionDetailed: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock('../services/api', () => ({
  uniswapApi,
}));

vi.mock('./useWalletConnection', () => ({
  useWalletConnection: () => walletMock,
}));

describe('useWalletExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletMock.isConnected = true;
    walletMock.address = '0x00000000000000000000000000000000000000ff';
    walletMock.chainId = 42161;
    walletMock.preflightTransaction.mockResolvedValue({ gas: '0x5208' });
    walletMock.submitTransactionDetailed.mockResolvedValue({ hash: '0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999' });
    walletMock.waitForTransactionReceipt.mockResolvedValue({
      status: 1,
      transactionHash: '0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999',
    });
    uniswapApi.finalizePositionAction.mockResolvedValue({
      operationId: 17,
      status: 'queued',
      step: 'queued',
    });
    uniswapApi.finalizeClaimFees.mockResolvedValue({
      operationId: 18,
      status: 'queued',
      step: 'queued',
    });
    uniswapApi.getOperation.mockResolvedValue({
      operationId: 17,
      status: 'done',
      txHashes: ['0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999'],
      result: {
        refreshedSnapshot: { positionIdentifier: '123' },
      },
    });
  });

  it('ejecuta el plan, registra finalize asíncrono y materializa el resultado final', async () => {
    const { result } = renderHook(() => useWalletExecution());

    let executionResult;
    await act(async () => {
      executionResult = await result.current.runPlan({
        action: 'modify-range',
        chainId: 42161,
        txPlan: [{
          clientTxId: 'tx-1',
          label: 'Approve USDC',
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: '0x0',
        }],
        finalizePayload: {
          network: 'arbitrum',
          version: 'v3',
          walletAddress: walletMock.address,
          positionIdentifier: '123',
        },
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe(WALLET_EXECUTION_STATE.DONE);
    });

    expect(walletMock.preflightTransaction).toHaveBeenCalledTimes(1);
    expect(walletMock.submitTransactionDetailed).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Approve USDC',
      gasEstimate: '0x5208',
    }), expect.objectContaining({
      actionKey: 'modify-range:0',
    }));
    expect(walletMock.waitForTransactionReceipt).toHaveBeenCalledWith(
      '0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999',
      expect.objectContaining({ chainId: 42161 })
    );
    expect(uniswapApi.finalizePositionAction).toHaveBeenCalledWith('modify-range', {
      network: 'arbitrum',
      version: 'v3',
      walletAddress: walletMock.address,
      positionIdentifier: '123',
      txHashes: ['0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999'],
    });
    expect(uniswapApi.getOperation).toHaveBeenCalledWith(17);
    expect(executionResult).toEqual(expect.objectContaining({
      refreshedSnapshot: { positionIdentifier: '123' },
      txHashes: ['0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999'],
      operationId: 17,
      status: 'done',
    }));
  });

  it('marca needs_reconcile cuando el backend termina en conciliación manual', async () => {
    uniswapApi.getOperation.mockResolvedValueOnce({
      operationId: 17,
      status: 'needs_reconcile',
      txHashes: ['0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999'],
      error: {
        code: 'FINALIZE_NEEDS_RECONCILE',
        message: 'Se confirmó la tx pero falló el refresh del snapshot.',
      },
      result: null,
    });

    const { result } = renderHook(() => useWalletExecution());

    let executionResult;
    await act(async () => {
      executionResult = await result.current.runPlan({
        action: 'increase-liquidity',
        chainId: 42161,
        txPlan: [{
          clientTxId: 'tx-1',
          label: 'Increase liquidity',
          to: '0x00000000000000000000000000000000000000aa',
          data: '0xabcd',
          value: '0x0',
        }],
        finalizePayload: {
          network: 'arbitrum',
          version: 'v3',
          walletAddress: walletMock.address,
          positionIdentifier: '123',
        },
      });
    });

    await waitFor(() => {
      expect(result.current.state).toBe(WALLET_EXECUTION_STATE.NEEDS_RECONCILE);
    });

    expect(result.current.normalizedError).toEqual(expect.objectContaining({
      code: 'server_finalize_pending',
    }));
    expect(executionResult).toEqual(expect.objectContaining({
      status: 'needs_reconcile',
      txHashes: ['0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999'],
    }));
  });
});

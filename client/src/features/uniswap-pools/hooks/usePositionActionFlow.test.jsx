import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePositionActionFlow, POSITION_ACTION_STEP } from './usePositionActionFlow';

const { uniswapApi } = vi.hoisted(() => ({
  uniswapApi: {
    preparePositionAction: vi.fn(),
    finalizePositionAction: vi.fn(),
    finalizeClaimFees: vi.fn(),
    getOperation: vi.fn(),
  },
}));

const walletMock = vi.hoisted(() => ({
  isConnected: true,
  address: '0x00000000000000000000000000000000000000ff',
  chainId: 8453,
  preflightTransaction: vi.fn(),
  submitTransactionDetailed: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock('../../../services/api', () => ({ uniswapApi }));
vi.mock('../../../hooks/useWalletConnection', () => ({ useWalletConnection: () => walletMock }));

const DECREASE_HASH = `0x${'d'.repeat(64)}`;
const SWAP_HASH = `0x${'5'.repeat(64)}`;
const MINT_HASH = `0x${'a'.repeat(64)}`;

const tx = (kind) => ({ kind, label: kind, to: '0x00000000000000000000000000000000000000aa', data: '0x12', value: '0x0', chainId: 8453 });

const FULL_PLAN = {
  network: 'base',
  version: 'v4',
  walletAddress: walletMock.address,
  positionIdentifier: '3110339',
  txPlan: [tx('decrease_liquidity_v4'), tx('swap_v4'), tx('mint_position_v4')],
  quoteSummary: {
    resumed: false,
    redeployFunding: { amount0Raw: '100', amount1Raw: '200' },
    postSwapFunding: { amount0Raw: '150', amount1Raw: '120' },
  },
};

const RESUMED_PLAN = {
  ...FULL_PLAN,
  txPlan: [tx('swap_v4'), tx('mint_position_v4')],
  quoteSummary: { ...FULL_PLAN.quoteSummary, resumed: true },
};

const buildPayload = (action, formState) => ({ ...formState });
const initialFormState = { network: 'base', version: 'v4', positionIdentifier: '3110339', rangeLowerPrice: 1800, rangeUpperPrice: 2200 };

describe('usePositionActionFlow · reintento de un ajuste de rango cortado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletMock.preflightTransaction.mockResolvedValue({ gas: '0x5208' });
    uniswapApi.finalizePositionAction.mockResolvedValue({ operationId: 1, status: 'done', result: {} });
  });

  it('tras minar el retiro, Reintentar prepara desde el swap y finaliza con todas las txs', async () => {
    // Intento 1: el retiro se mina, el swap revierte.
    walletMock.submitTransactionDetailed
      .mockResolvedValueOnce({ hash: DECREASE_HASH })
      .mockResolvedValueOnce({ hash: SWAP_HASH });
    walletMock.waitForTransactionReceipt
      .mockResolvedValueOnce({ status: 1, transactionHash: DECREASE_HASH })
      .mockResolvedValueOnce({ status: 0, transactionHash: SWAP_HASH });

    const { result } = renderHook(() => usePositionActionFlow({
      action: 'modify-range',
      initialFormState,
      buildPayload,
      prefilledPrepareResult: FULL_PLAN,
    }));

    await act(async () => { await result.current.handleExecute(); });
    await waitFor(() => expect(result.current.step).toBe(POSITION_ACTION_STEP.ERROR));
    expect(result.current.canResume).toBe(true);

    // Reintentar: el prepare lleva el capital que libero el retiro.
    uniswapApi.preparePositionAction.mockResolvedValue(RESUMED_PLAN);
    await act(async () => { await result.current.handlePrepare(); });
    expect(uniswapApi.preparePositionAction).toHaveBeenCalledWith('modify-range', expect.objectContaining({
      resumeFunding: { amount0Raw: '100', amount1Raw: '200' },
    }));
    expect(result.current.step).toBe(POSITION_ACTION_STEP.REVIEW);

    // Intento 2: swap + mint; el finalize incluye el retiro del intento 1.
    walletMock.submitTransactionDetailed
      .mockResolvedValueOnce({ hash: SWAP_HASH })
      .mockResolvedValueOnce({ hash: MINT_HASH });
    walletMock.waitForTransactionReceipt
      .mockResolvedValueOnce({ status: 1, transactionHash: SWAP_HASH })
      .mockResolvedValueOnce({ status: 1, transactionHash: MINT_HASH });
    await act(async () => { await result.current.handleExecute(); });

    expect(uniswapApi.finalizePositionAction).toHaveBeenCalledWith('modify-range', expect.objectContaining({
      txHashes: [DECREASE_HASH, SWAP_HASH, MINT_HASH],
    }));
  });

  it('si falla antes de minar el retiro, Reintentar prepara el plan entero', async () => {
    walletMock.submitTransactionDetailed.mockResolvedValueOnce({ hash: DECREASE_HASH });
    walletMock.waitForTransactionReceipt.mockResolvedValueOnce({ status: 0, transactionHash: DECREASE_HASH });

    const { result } = renderHook(() => usePositionActionFlow({
      action: 'modify-range',
      initialFormState,
      buildPayload,
      prefilledPrepareResult: FULL_PLAN,
    }));

    await act(async () => { await result.current.handleExecute(); });
    await waitFor(() => expect(result.current.step).toBe(POSITION_ACTION_STEP.ERROR));
    expect(result.current.canResume).toBe(false);

    uniswapApi.preparePositionAction.mockResolvedValue(FULL_PLAN);
    await act(async () => { await result.current.handlePrepare(); });
    expect(uniswapApi.preparePositionAction.mock.calls[0][1].resumeFunding).toBeUndefined();
  });
});

describe('usePositionActionFlow · aviso de ajuste en curso', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletMock.preflightTransaction.mockResolvedValue({ gas: '0x5208' });
    walletMock.submitTransactionDetailed.mockResolvedValue({ hash: DECREASE_HASH });
    walletMock.waitForTransactionReceipt.mockResolvedValue({ status: 1, transactionHash: DECREASE_HASH });
    uniswapApi.finalizePositionAction.mockResolvedValue({ operationId: 1, status: 'done', result: {} });
  });

  const plan = { ...FULL_PLAN, txPlan: [tx('decrease_liquidity_v4')] };

  it('handleExecute llama a onExecuteStarted antes de la primera firma', async () => {
    const onExecuteStarted = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => usePositionActionFlow({
      action: 'modify-range', initialFormState, buildPayload, prefilledPrepareResult: plan, onExecuteStarted,
    }));
    await act(async () => { await result.current.handleExecute(); });
    expect(onExecuteStarted).toHaveBeenCalledWith('modify-range');
    expect(onExecuteStarted.mock.invocationCallOrder[0])
      .toBeLessThan(walletMock.submitTransactionDetailed.mock.invocationCallOrder[0]);
  });

  it('si onExecuteStarted falla, la firma sigue adelante', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onExecuteStarted = vi.fn().mockRejectedValue(new Error('red caída'));
    const { result } = renderHook(() => usePositionActionFlow({
      action: 'modify-range', initialFormState, buildPayload, prefilledPrepareResult: plan, onExecuteStarted,
    }));
    await act(async () => { await result.current.handleExecute(); });
    expect(walletMock.submitTransactionDetailed).toHaveBeenCalled();
    warn.mockRestore();
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import useBringFunds from './useBringFunds';

vi.mock('../../lib/wallet/clients', () => ({
  getPublicClientForChain: () => ({ getTransaction: async () => ({ nonce: 7 }) }),
}));

function plan(steps, status = 'executing') {
  return { id: 3, status, steps };
}
const STEP_1 = { order: 1, sourceNetwork: 'arbitrum', status: 'pending', token: { isNative: false } };
const STEP_2 = { order: 2, sourceNetwork: 'arbitrum', status: 'pending', token: { isNative: true } };

const tx = (kind, extra = {}) => ({
  kind, chainId: 42161, to: '0xto', data: '0x', value: '0', gas: '300000', maxFeePerGas: '100', maxPriorityFeePerGas: '0', ...extra,
});

function fakeApi(sequence) {
  let current = sequence[0];
  return {
    getPlan: vi.fn(async () => current),
    prepareStep: vi.fn(async (planId, order, opts) => {
      if (opts?.speedUp) return { profile: 'medium', txs: [tx('bridge', { nonce: 7, maxFeePerGas: '120', replacement: true })] };
      return order === 1
        ? { profile: 'low', requiresReconfirm: false, txs: [tx('approval'), tx('bridge')] }
        : { profile: 'low', requiresReconfirm: true, previousCostUsd: 0.2, newCostUsd: 0.5, txs: [tx('bridge')] };
    }),
    submitStep: vi.fn(async (planId, order, body) => {
      if (body.kind === 'bridge') {
        current = plan(current.steps.map((s) => (s.order === order ? { ...s, status: 'signed' } : s)));
      }
      return {};
    }),
    skipStep: vi.fn(async () => current),
    continueWithArrived: vi.fn(async () => ({ ...current, status: 'partial' })),
    discardPlan: vi.fn(async () => ({ ...current, status: 'discarded' })),
    setCurrent: (next) => { current = next; },
  };
}

function fakeWallet() {
  let n = 0;
  return {
    switchChain: vi.fn(async () => true),
    sendTransaction: vi.fn(async () => `0xhash${++n}`),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  };
}

describe('useBringFunds', () => {
  it('firma approve + bridge, registra cada uno y espera el bridge si queda otro paso en la misma red', async () => {
    const api = fakeApi([plan([STEP_1, STEP_2])]);
    const wallet = fakeWallet();
    const { result } = renderHook(() => useBringFunds({ planId: 3, wallet, api, pollMs: 60_000 }));
    await waitFor(() => expect(result.current.plan).not.toBeNull());

    let run;
    act(() => { run = result.current.start(); });
    // El paso 2 pide reconfirmar: el costo subió.
    await waitFor(() => expect(result.current.confirm).not.toBeNull());
    expect(result.current.confirm).toMatchObject({ order: 2, previousCostUsd: 0.2, newCostUsd: 0.5 });
    expect(api.submitStep).toHaveBeenCalledWith(3, 1, { kind: 'approval', txHash: '0xhash1' });
    expect(api.submitStep).toHaveBeenCalledWith(3, 1, expect.objectContaining({
      kind: 'bridge', txHash: '0xhash2', nonce: 7,
      fees: { profile: 'low', maxFeePerGas: '100', maxPriorityFeePerGas: '0', gasLimit: '300000' },
    }));
    // approve esperado + bridge esperado (queda el nativo en Arbitrum)
    expect(wallet.waitForTransactionReceipt).toHaveBeenCalledWith('0xhash2', { chainId: 42161 });
    expect(wallet.switchChain).toHaveBeenCalledWith(42161);

    await act(async () => { result.current.answerConfirm(true); await run; });
    expect(api.submitStep).toHaveBeenCalledWith(3, 2, expect.objectContaining({ kind: 'bridge', txHash: '0xhash3' }));
    expect(result.current.running).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('rechazar la reconfirmación detiene la firma sin enviar', async () => {
    const api = fakeApi([plan([{ ...STEP_1, status: 'signed' }, STEP_2])]);
    const wallet = fakeWallet();
    const { result } = renderHook(() => useBringFunds({ planId: 3, wallet, api, pollMs: 60_000 }));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    let run;
    act(() => { run = result.current.start(); });
    await waitFor(() => expect(result.current.confirm).not.toBeNull());
    await act(async () => { result.current.answerConfirm(false); await run; });
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('un error de la wallet queda visible y no sigue firmando', async () => {
    const api = fakeApi([plan([STEP_1, STEP_2])]);
    const wallet = fakeWallet();
    wallet.sendTransaction = vi.fn(async () => { throw new Error('Rechazada por el usuario'); });
    const { result } = renderHook(() => useBringFunds({ planId: 3, wallet, api, pollMs: 60_000 }));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toMatch(/Rechazada/);
    expect(api.prepareStep).toHaveBeenCalledTimes(1);
  });

  it('acelerar reenvía con el mismo nonce y lo marca como reemplazo', async () => {
    const api = fakeApi([plan([{ ...STEP_1, status: 'signed' }])]);
    const wallet = fakeWallet();
    const { result } = renderHook(() => useBringFunds({ planId: 3, wallet, api, pollMs: 60_000 }));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    await act(async () => { await result.current.speedUp(1); });
    expect(api.prepareStep).toHaveBeenCalledWith(3, 1, { speedUp: true });
    expect(wallet.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 7, maxFeePerGas: '120' }));
    expect(api.submitStep).toHaveBeenCalledWith(3, 1, expect.objectContaining({
      nonce: 7, fees: expect.objectContaining({ profile: 'medium', replacement: true }),
    }));
  });

  it('seguir con lo que llegó y descartar actualizan el plan', async () => {
    const api = fakeApi([plan([STEP_1])]);
    const { result } = renderHook(() => useBringFunds({ planId: 3, wallet: fakeWallet(), api, pollMs: 60_000 }));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    await act(async () => { await result.current.continueWithArrived(); });
    expect(result.current.plan.status).toBe('partial');
    expect(result.current.done).toBe(true);
    await act(async () => { await result.current.discard(); });
    expect(result.current.plan.status).toBe('discarded');
  });

  it('si la wallet no cambia de red, no envía nada (la tx es de otra red)', async () => {
    const api = fakeApi([plan([STEP_1])]);
    const wallet = fakeWallet();
    wallet.switchChain = vi.fn(async () => false);
    const { result } = renderHook(() => useBringFunds({ planId: 3, wallet, api, pollMs: 60_000 }));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    await act(async () => { await result.current.start(); });
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/red/i);
  });

  it('descartar el plan sale de «Traer fondos»', async () => {
    const api = fakeApi([plan([STEP_1])]);
    const onExit = vi.fn();
    const { result } = renderHook(() => useBringFunds({ planId: 3, wallet: fakeWallet(), api, pollMs: 60_000, onExit }));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    await act(async () => { await result.current.discard(); });
    expect(onExit).toHaveBeenCalled();
  });
});

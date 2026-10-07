import { useCallback, useEffect, useRef, useState } from 'react';
import { crossChainApi } from '../../services/api';
import { getPublicClientForChain } from '../../lib/wallet/clients';

function errorMessage(err) {
  return err?.normalizedError?.message || err?.message || String(err);
}

/**
 * Ejecuta un plan de fondeo cross-chain paso a paso con la wallet.
 *
 * Firma en el orden del plan (por red, ERC20 antes que el nativo). Dentro de
 * una misma red espera el bridge antes del siguiente envío, porque el
 * servidor recorta el nativo con el saldo real; entre redes distintas sigue
 * de inmediato. Cada hash se registra en el servidor en cuanto existe, así un
 * cierre de la ventana nunca deja un envío sin rastro.
 */
export default function useBringFunds({ planId, wallet, api = crossChainApi, pollMs = 5_000 }) {
  const [plan, setPlan] = useState(null);
  const [running, setRunning] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState(null);
  const resolver = useRef(null);

  const refresh = useCallback(async () => {
    if (!planId) return null;
    const next = await api.getPlan(planId);
    setPlan(next);
    return next;
  }, [api, planId]);

  useEffect(() => {
    if (!planId) return undefined;
    refresh().catch((err) => setError(errorMessage(err)));
    const id = setInterval(() => { refresh().catch(() => {}); }, pollMs);
    return () => clearInterval(id);
  }, [planId, pollMs, refresh]);

  const askConfirm = (info) => new Promise((resolve) => {
    resolver.current = resolve;
    setConfirm(info);
  });

  const answerConfirm = useCallback((accepted) => {
    resolver.current?.(accepted);
    resolver.current = null;
    setConfirm(null);
  }, []);

  async function sendAndRecord(order, tx, profile, { replacement = false } = {}) {
    const chainId = Number(tx.chainId);
    await wallet.switchChain(chainId);
    const hash = await wallet.sendTransaction(tx);
    if (!hash) throw new Error('La wallet no devolvió el hash de la transacción.');
    if (tx.kind === 'approval') {
      await api.submitStep(planId, order, { kind: 'approval', txHash: hash });
      await wallet.waitForTransactionReceipt(hash, { chainId });
      return hash;
    }
    let nonce = tx.nonce ?? null;
    if (nonce == null) {
      try {
        nonce = Number((await getPublicClientForChain(chainId).getTransaction({ hash })).nonce);
      } catch {
        nonce = null;
      }
    }
    await api.submitStep(planId, order, {
      kind: 'bridge',
      txHash: hash,
      nonce,
      fees: {
        profile,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        gasLimit: tx.gas,
        ...(replacement ? { replacement: true } : {}),
      },
    });
    return hash;
  }

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      let current = await refresh();
      for (;;) {
        const next = current?.steps?.find((step) => step.status === 'pending');
        if (!next) break;
        setActiveOrder(next.order);
        const prepared = await api.prepareStep(planId, next.order);
        if (prepared.requiresReconfirm) {
          const accepted = await askConfirm({
            order: next.order,
            previousCostUsd: prepared.previousCostUsd,
            newCostUsd: prepared.newCostUsd,
          });
          if (!accepted) break;
        }
        let bridge = null;
        for (const tx of prepared.txs) {
          const hash = await sendAndRecord(next.order, tx, prepared.profile);
          if (tx.kind === 'bridge') bridge = { hash, chainId: Number(tx.chainId) };
        }
        current = await refresh();
        const moreHere = current.steps.some((step) => step.status === 'pending' && step.sourceNetwork === next.sourceNetwork);
        if (moreHere && bridge) await wallet.waitForTransactionReceipt(bridge.hash, { chainId: bridge.chainId });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setActiveOrder(null);
      setRunning(false);
      refresh().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, planId, refresh, wallet]);

  const speedUp = useCallback(async (order) => {
    setError(null);
    try {
      const prepared = await api.prepareStep(planId, order, { speedUp: true });
      await sendAndRecord(order, prepared.txs[0], prepared.profile, { replacement: true });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, planId, refresh, wallet]);

  const act = (fn) => async (...args) => {
    setError(null);
    try {
      const next = await fn(...args);
      if (next) setPlan(next);
      return next;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  };

  return {
    plan,
    running,
    activeOrder,
    confirm,
    error,
    done: Boolean(plan && plan.status !== 'executing'),
    start,
    answerConfirm,
    speedUp,
    skip: act((order) => api.skipStep(planId, order)),
    continueWithArrived: act(() => api.continueWithArrived(planId)),
    discard: act(() => api.discardPlan(planId)),
    refresh,
  };
}

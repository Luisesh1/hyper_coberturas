import { useCallback, useEffect, useMemo, useState } from 'react';
import { crossChainApi } from '../../services/api';
import useCrossChainFunding from '../cross-chain-funding/useCrossChainFunding';

function pickToken(token) {
  return token ? { address: token.address, symbol: token.symbol, decimals: Number(token.decimals) } : null;
}

/**
 * Pegamento entre el asistente y el fondeo cross-chain: arma la petición de
 * análisis con el pool y el rango elegidos, crea el plan, retoma uno en curso
 * de la misma wallet y, cuando los fondos llegan, rehace el fondeo de la red
 * del LP con los saldos reales (fase 2) y sigue a Revisión.
 */
export default function useCrossChainStep({ flow, walletAddress, onFunding }) {
  const suggestions = flow.suggestions;
  const range = flow.activeRange;
  const request = useMemo(() => {
    if (!onFunding || !walletAddress || !suggestions?.token0 || !suggestions?.token1 || !range) return null;
    return {
      walletAddress,
      network: flow.network,
      version: flow.version,
      token0: pickToken(suggestions.token0),
      token1: pickToken(suggestions.token1),
      totalUsdTarget: Number(flow.totalUsdTarget),
      targetWeightToken0Pct: Number(range.targetWeightToken0Pct),
      maxSlippageBps: Number(flow.maxSlippageBps || 50),
      wizardContext: {
        fee: Number(flow.fee),
        token0Address: flow.token0Address,
        token1Address: flow.token1Address,
      },
    };
  }, [onFunding, walletAddress, suggestions, range, flow.network, flow.version, flow.totalUsdTarget,
    flow.maxSlippageBps, flow.fee, flow.token0Address, flow.token1Address]);

  const funding = useCrossChainFunding({ request, enabled: onFunding });
  const [planId, setPlanId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState(null);

  // Un plan en curso de esta wallet hacia esta red se retoma, no se duplica.
  useEffect(() => {
    if (!onFunding || !walletAddress || !funding.available || planId) return undefined;
    let alive = true;
    crossChainApi.getActivePlan(walletAddress)
      .then((plan) => { if (alive && plan && plan.destinationNetwork === flow.network) setPlanId(plan.id); })
      .catch(() => {});
    return () => { alive = false; };
  }, [onFunding, walletAddress, funding.available, planId, flow.network]);

  const bringFunds = useCallback(async () => {
    if (!funding.planInput) return;
    setBusy(true);
    setStartError(null);
    try {
      const plan = await crossChainApi.createPlan(funding.planInput);
      setPlanId(plan.id);
    } catch (err) {
      setStartError(err?.message || 'No se pudo crear el plan de fondeo.');
    } finally {
      setBusy(false);
    }
  }, [funding.planInput]);

  // Fase 2: el fondeo de siempre sobre lo que llegó, y a Revisión.
  const finish = useCallback(async () => {
    setPlanId(null);
    await flow.retryFromChain();
  }, [flow]);

  // Descartar el plan vuelve al fondeo normal; lo que ya llegó se ve al recalcular.
  const exit = useCallback(() => {
    setPlanId(null);
    funding.refresh();
  }, [funding]);

  return { funding, planId, bringing: Boolean(planId), bringFunds, finish, exit, busy, startError };
}

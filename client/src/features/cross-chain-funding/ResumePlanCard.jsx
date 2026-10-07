import { useEffect, useState } from 'react';
import { crossChainApi } from '../../services/api';
import { PROFILE_OPTIONS } from './format';
import { NETWORK_LABELS } from './networks';
import styles from './CrossChainFundingPanel.module.css';

export function wizardDefaultsFromPlan(plan) {
  const request = plan?.request || {};
  const context = request.wizardContext || {};
  return {
    network: request.network || plan.destinationNetwork,
    version: request.version || 'v4',
    token0Address: context.token0Address || request.token0?.address,
    token1Address: context.token1Address || request.token1?.address,
    fee: context.fee,
    totalUsdTarget: request.totalUsdTarget,
  };
}

/**
 * Aviso de «Crear orquestador» cuando la wallet dejó un plan de fondeo
 * cross-chain a medias: retomarlo reabre el asistente en ese pool.
 */
export default function ResumePlanCard({ walletAddress, onResume }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!walletAddress) return undefined;
    let alive = true;
    (async () => {
      try {
        const config = await crossChainApi.getConfig();
        if (!alive || !config || config.mode === 'off') return;
        const active = await crossChainApi.getActivePlan(walletAddress);
        if (alive) setPlan(active || null);
      } catch {
        // Sin aviso: el asistente detecta el plan igual al llegar a Fondeo.
      }
    })();
    return () => { alive = false; };
  }, [walletAddress]);

  if (!plan) return null;
  const delivered = plan.steps.filter((step) => step.status === 'delivered').length;
  const inFlight = plan.steps.filter((step) => step.status === 'signed' || step.status === 'source_confirmed').length;
  const destination = NETWORK_LABELS[plan.destinationNetwork] || plan.destinationNetwork;
  const profile = PROFILE_OPTIONS.find((option) => option.id === plan.profile)?.label || plan.profile;

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      await crossChainApi.discardPlan(plan.id);
      setPlan(null);
    } catch (err) {
      setError(err?.message || 'No se pudo descartar el plan.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="cc-resume-title">
      <h3 id="cc-resume-title" className={styles.title}>Tienes un plan de fondeo en curso</h3>
      <span className={styles.muted}>
        {plan.request?.token0?.symbol}/{plan.request?.token1?.symbol} en {destination} · perfil {profile.toLowerCase()} ·{' '}
        {delivered} de {plan.steps.length} envíos entregados{inFlight ? ` · ${inFlight} en camino` : ''}
      </span>
      <span className={styles.hint}>Descartar no mueve fondos: lo que ya llegó se queda en {destination}.</span>
      {error && <p className={styles.warn} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => onResume?.(plan)} disabled={busy}>
          Continuar trayendo fondos
        </button>
        <button type="button" className={styles.secondary} onClick={discard} disabled={busy}>Descartar plan</button>
      </div>
    </section>
  );
}

import { STEP_STATUS_LABELS, formatAmount, formatUsd, providerLabel } from './format';
import styles from './CrossChainFundingPanel.module.css';

function StepActions({ step, running, onSpeedUp, onSkip, onContinueWithArrived }) {
  if (step.status === 'signed') {
    return (
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => onSpeedUp?.(step.order)}>
          Acelerar (sube un perfil)
        </button>
      </div>
    );
  }
  if (step.status === 'source_confirmed' && step.isSlow) {
    return (
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onContinueWithArrived}>Seguir con lo que llegó</button>
      </div>
    );
  }
  if ((step.status === 'failed' || step.status === 'refunded' || step.status === 'pending') && !running) {
    return (
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} aria-label={`Saltar envío ${step.order}`} onClick={() => onSkip?.(step.order)}>
          Saltar
        </button>
      </div>
    );
  }
  return null;
}

/**
 * Subpaso «Traer fondos»: progreso de cada envío, acciones de rescate
 * (acelerar, saltar, seguir con lo que llegó) y, al final, estimado vs real.
 */
export default function BringFundsStep({
  plan,
  networkLabels = {},
  running,
  activeOrder,
  confirm,
  error,
  onStart,
  onAnswerConfirm,
  onSpeedUp,
  onSkip,
  onContinueWithArrived,
  onDiscard,
  onContinueToLp,
  protectionSlot = null,
}) {
  if (!plan) return <p className={styles.muted}>Cargando el plan de fondeo…</p>;
  const destination = networkLabels[plan.destinationNetwork] || plan.destinationNetwork;
  const delivered = plan.steps.filter((step) => step.status === 'delivered');
  const arrivedUsd = delivered.reduce((acc, step) => acc + (Number(step.receivedUsd) || 0), 0);
  const expectedUsd = plan.steps.reduce((acc, step) => acc + (Number(step.receivedUsd) || 0), 0);
  const hasPending = plan.steps.some((step) => step.status === 'pending');
  const finished = plan.status !== 'executing';
  const pct = expectedUsd > 0 ? Math.min(100, (arrivedUsd / expectedUsd) * 100) : 0;
  const estTotal = plan.steps.reduce((acc, step) => acc + (Number(step.estCostUsd) || 0), 0);
  const realTotal = plan.steps.reduce((acc, step) => acc + (Number(step.realCostUsd) || 0), 0);

  return (
    <div className={styles.panel}>
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h3 className={styles.title}>{finished ? `Fondos en ${destination}` : `Trayendo fondos a ${destination}`}</h3>
          <span className={styles.muted}>Plan guardado: puedes cerrar y volver más tarde.</span>
        </header>
        <span className={styles.muted}>
          {delivered.length} de {plan.steps.length} envíos entregados · {formatUsd(arrivedUsd)} de {formatUsd(expectedUsd)}
        </span>
        <progress className={styles.progress} max={100} value={pct} aria-label="Fondos entregados" />
        {error && <p className={styles.warn} role="alert">{error}</p>}
        {plan.status === 'discarded' && <p className={styles.warn}>Plan descartado. Lo que ya llegó sigue en {destination}.</p>}
        {!finished && hasPending && (
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={onStart} disabled={running}>
              {running ? 'Firmando…' : 'Firmar envíos'}
            </button>
            <button type="button" className={styles.secondary} onClick={onDiscard} disabled={running}>Descartar plan</button>
          </div>
        )}
      </section>

      {confirm && (
        <div className={styles.card} role="alertdialog" aria-label="El costo cambió">
          <strong>
            El envío {confirm.order} cuesta ahora {formatUsd(confirm.newCostUsd)} (antes {formatUsd(confirm.previousCostUsd)}).
          </strong>
          <span className={styles.muted}>
            Antes {formatUsd(confirm.previousCostUsd)} → ahora {formatUsd(confirm.newCostUsd)}. La cotización o el gas cambiaron desde el análisis.
          </span>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => onAnswerConfirm?.(true)}>Firmar igual</button>
            <button type="button" className={styles.secondary} onClick={() => onAnswerConfirm?.(false)}>Detener</button>
          </div>
        </div>
      )}

      <ol className={styles.steps}>
        {plan.steps.map((step) => {
          const source = networkLabels[step.sourceNetwork] || step.sourceNetwork;
          return (
            <li key={step.order} className={styles.step} aria-label={`Envío ${step.order}: ${source}`}>
              <span className={styles.stepNum} aria-hidden="true">{step.order}</span>
              <div className={styles.stepBody}>
                <strong>{source} → {destination} · {step.token.symbol}</strong>
                <span className={styles.num}>
                  {formatAmount(step.amountRaw, step.token.decimals)} {step.token.symbol} · {providerLabel(step.provider)}
                </span>
                <span className={styles.muted}>
                  {activeOrder === step.order && running ? 'Firmando…' : STEP_STATUS_LABELS[step.status] || step.status}
                  {step.txHash ? ` · ${step.txHash.slice(0, 10)}…` : ''}
                </span>
                {step.status === 'source_confirmed' && step.isSlow && (
                  <span className={styles.warn}>
                    Tarda más de lo previsto. Los fondos no se pierden: si el relayer no lo cubre, el bridge lo reembolsa en {source}.
                  </span>
                )}
                {step.errorMessage && <span className={styles.warn}>{step.errorMessage}</span>}
                {step.walletOverrodeFees && (
                  <span className={styles.warn}>La wallet pagó más gas que el tope del perfil: ignoró las fees enviadas.</span>
                )}
                <StepActions
                  step={step}
                  running={running}
                  onSpeedUp={onSpeedUp}
                  onSkip={onSkip}
                  onContinueWithArrived={onContinueWithArrived}
                />
              </div>
              <div className={styles.stepCost}>
                <span className={styles.num}>{formatUsd(step.realCostUsd ?? step.estCostUsd)}</span>
                <span className={styles.muted}>{step.realCostUsd != null ? 'real' : 'estimado'}</span>
              </div>
            </li>
          );
        })}
      </ol>

      {!finished && protectionSlot}

      {finished && plan.status !== 'discarded' && (
        <section className={styles.card}>
          <h3 className={styles.title}>Estimado vs real</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="Estimado vs real">
              <thead>
                <tr>
                  <th scope="col">Envío</th>
                  <th scope="col" className={styles.right}>Estimado</th>
                  <th scope="col" className={styles.right}>Real</th>
                </tr>
              </thead>
              <tbody>
                {plan.steps.map((step) => (
                  <tr key={step.order}>
                    <td>{step.order} · {networkLabels[step.sourceNetwork] || step.sourceNetwork} · {STEP_STATUS_LABELS[step.status]}</td>
                    <td className={`${styles.right} ${styles.num}`}>{formatUsd(step.estCostUsd)}</td>
                    <td className={`${styles.right} ${styles.num}`}>{formatUsd(step.realCostUsd)}</td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Total de los envíos</strong></td>
                  <td className={`${styles.right} ${styles.num}`}>{formatUsd(estTotal)}</td>
                  <td className={`${styles.right} ${styles.num}`}>{formatUsd(realTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={onContinueToLp}>Continuar con el LP</button>
          </div>
          <p className={styles.hint}>El fondeo del LP se recalcula con los saldos reales de {destination} antes de firmar.</p>
        </section>
      )}
    </div>
  );
}

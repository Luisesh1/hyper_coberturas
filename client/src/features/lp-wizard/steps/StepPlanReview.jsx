import styles from '../UnifiedLpWizard.module.css';

function Row({ k, v }) {
  return (
    <div className={styles.kv}>
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

/**
 * El plan anotado por reversibilidad. Es la pieza que hace honesta la
 * promesa de atomicidad: el usuario ve, antes de firmar, qué pasos se pueden
 * deshacer y cuáles no.
 */
function planSteps({ isOrchestrated, txPlan, protectionEnabled }) {
  const steps = [];
  if (isOrchestrated) {
    steps.push({ label: 'Registrar la intención en el servidor', tag: 'reversible' });
  }
  // Las etiquetas reales del plan («Approve USDC», «Mint») dicen mucho más
  // que un «transacción 1 de 3», y son las que el usuario verá en la wallet.
  txPlan.forEach((tx, i) => {
    steps.push({ label: tx.label || `Transacción ${i + 1}`, tag: 'on-chain' });
  });
  if (isOrchestrated) {
    if (protectionEnabled) {
      steps.push({ label: 'Abrir el short en Hyperliquid', tag: 'reversible' });
    }
    steps.push({ label: 'Crear el orquestador y vincularlo todo', tag: 'reversible' });
  }
  return steps;
}

export default function StepPlanReview({
  plan,
  isOrchestrated,
  prepareData,
  preflight,
  rangeWidthPct,
  reviewFundingAssets,
  reviewSwapPlan,
}) {
  const txPlan = prepareData?.txPlan || [];
  const protectionEnabled = plan?.protection?.enabled !== false;
  const steps = planSteps({ isOrchestrated, txPlan, protectionEnabled });

  return (
    <div className={styles.stepBody}>
      <h3 className={styles.stepHeading}>
        {isOrchestrated ? 'Paso 5: Revisión y firma' : 'Paso 4: Revisión y firma'}
      </h3>

      <section className={styles.card}>
        <h4 className={styles.cardTitle}>Posición</h4>
        <Row k="Pool" v={`${plan.token0Symbol} / ${plan.token1Symbol} · ${(plan.feeTier / 10000).toFixed(2)}%`} />
        <Row k="Red" v={`${plan.network} · ${plan.version}`} />
        <Row
          k="Rango"
          v={`${plan.rangeLowerPrice?.toFixed?.(2) ?? plan.rangeLowerPrice} — ${plan.rangeUpperPrice?.toFixed?.(2) ?? plan.rangeUpperPrice}${rangeWidthPct != null ? ` (±${rangeWidthPct}%)` : ''}`}
        />
        <Row k="Capital" v={`$${plan.capitalUsd}`} />
      </section>

      {isOrchestrated && (
        <section className={styles.card}>
          <h4 className={styles.cardTitle}>Cobertura</h4>
          {protectionEnabled ? (
            <>
              <Row k="Cuenta" v={`#${plan.protection.accountId} · short ${preflight?.computed?.asset || ''}`} />
              <Row k="Notional · leverage" v={`$${plan.protection.configuredNotionalUsd ?? plan.capitalUsd} · ${plan.protection.leverage}×`} />
              {preflight?.computed?.requiredMarginUsd != null && (
                <Row
                  k="Margen requerido"
                  v={`$${preflight.computed.requiredMarginUsd} · $${preflight.computed.freeMarginUsd} libre`}
                />
              )}
            </>
          ) : (
            <Row k="Estado" v="Desactivada" />
          )}
        </section>
      )}

      {isOrchestrated && (
        <section className={styles.card}>
          <h4 className={styles.cardTitle}>Estrategia heredada</h4>
          <Row k="Ancho del rango" v={rangeWidthPct != null ? `±${rangeWidthPct}%` : '—'} />
          <Row k="Margen de borde" v={`${plan.strategy?.edgeMarginPct}%`} />
        </section>
      )}

      <section className={styles.card}>
        <h4 className={styles.cardTitle}>Activos fuente seleccionados</h4>
        {reviewFundingAssets?.map((asset) => (
          <div key={`${asset.assetId}-${asset.fundingRole}`} className={styles.kv}>
            <span>{asset.symbol}</span>
            <strong>
              {asset.useAmount} · {asset.fundingRole === 'swap_source' ? 'Swap source' : 'Aporte directo'}
            </strong>
          </div>
        ))}
      </section>

      {reviewSwapPlan?.length > 0 && (
        <section className={styles.card}>
          <h4 className={styles.cardTitle}>Swaps</h4>
          {reviewSwapPlan.map((swap, index) => (
            <div key={`${swap.sourceAssetId}-${index}`} className={styles.kv}>
              <span>{swap.amountIn} {swap.tokenIn.symbol}</span>
              <strong>→ min {swap.amountOutMinimum} {swap.tokenOut.symbol}</strong>
            </div>
          ))}
        </section>
      )}

      {(prepareData?.warnings || []).length > 0 && (
        <section className={`${styles.card} ${styles.cardWarn}`}>
          <h4 className={styles.cardTitle}>Advertencias</h4>
          {(prepareData.warnings || []).map((warning) => (
            <p key={warning} className={styles.hint}>{warning}</p>
          ))}
        </section>
      )}

      <section className={`${styles.card} ${styles.cardWarn}`}>
        <h4 className={styles.cardTitle}>
          Se ejecutará en este orden · Transacciones a firmar ({txPlan.length})
        </h4>
        <ol className={styles.planList}>
          {steps.map((step, i) => (
            <li key={step.label} className={styles.planRow}>
              <span className={styles.planNum}>{i + 1}</span>
              <span className={styles.planLabel}>{step.label}</span>
              <span className={step.tag === 'on-chain' ? styles.tagOnChain : styles.tag}>{step.tag}</span>
            </li>
          ))}
        </ol>
        {isOrchestrated && (
          <p className={styles.hint}>
            Las transacciones on-chain no se pueden deshacer. Si falla algo
            después, se revierte lo reversible y se te ofrece qué hacer con el LP.
          </p>
        )}
      </section>
    </div>
  );
}

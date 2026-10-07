import {
  PROFILE_OPTIONS,
  ROLE_LABELS,
  formatAmount,
  formatPct,
  formatUsd,
  providerLabel,
} from './format';
import styles from './CrossChainFundingPanel.module.css';

const ROLE_TONE = {
  destination: styles.toneInfo,
  used: styles.toneAccent,
  excluded: styles.toneWarn,
  no_route: styles.toneWarn,
  no_price: styles.toneWarn,
};

function RowAction({ row, networkLabel, forced, disabled, onToggleForced, onToggleDisabled }) {
  if (row.role === 'excluded' || forced) {
    return (
      <button
        type="button"
        className={styles.rowBtn}
        aria-pressed={forced}
        aria-label={`${forced ? 'Quitar forzado de' : 'Forzar'} ${row.symbol} en ${networkLabel}`}
        onClick={() => onToggleForced?.(row.id)}
      >
        {forced ? 'Quitar' : 'Forzar'}
      </button>
    );
  }
  if (row.role === 'used' || row.role === 'not_needed' || disabled) {
    return (
      <button
        type="button"
        className={styles.rowBtn}
        aria-label={`${disabled ? 'Activar' : 'Desactivar'} ${row.symbol} en ${networkLabel}`}
        onClick={() => onToggleDisabled?.(row.id)}
      >
        {disabled ? 'Activar' : 'Desactivar'}
      </button>
    );
  }
  return null;
}

function BalancesTable({ analysis, forcedSources, disabledSources, onToggleForced, onToggleDisabled }) {
  const unreadable = analysis.balances.networks.filter((network) => network.status !== 'ok');
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h3 className={styles.title}>Saldos en todas las redes</h3>
        <span className={styles.muted}>
          Total <strong className={styles.num}>{formatUsd(analysis.balances.totalUsd)}</strong>
        </span>
      </header>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label="Saldos en todas las redes">
          <thead>
            <tr>
              <th scope="col">Red</th>
              <th scope="col">Token</th>
              <th scope="col" className={styles.right}>Saldo</th>
              <th scope="col" className={styles.right}>USD</th>
              <th scope="col">En el plan</th>
              <th scope="col"><span className={styles.srOnly}>Acción</span></th>
            </tr>
          </thead>
          <tbody>
            {analysis.balances.networks.filter((network) => network.status === 'ok').flatMap((network) => network.rows.map((row) => (
              <tr key={row.id}>
                <td>{network.label}</td>
                <td>{row.symbol}</td>
                <td className={`${styles.right} ${styles.num}`}>{formatAmount(row.balanceRaw, row.decimals)}</td>
                <td className={`${styles.right} ${styles.num}`}>{formatUsd(row.usd)}</td>
                <td>
                  <span className={`${styles.pill} ${ROLE_TONE[row.role] || ''}`}>{ROLE_LABELS[row.role] || row.role}</span>
                  {row.role === 'used' && row.usedAmountRaw !== '0' && (
                    <span className={styles.muted}> {formatAmount(row.usedAmountRaw, row.decimals)}</span>
                  )}
                  {row.reason && <div className={styles.reason}>{row.reason}</div>}
                </td>
                <td className={styles.right}>
                  {!network.isDestination && (
                    <RowAction
                      row={row}
                      networkLabel={network.label}
                      forced={forcedSources.includes(row.id)}
                      disabled={disabledSources.includes(row.id)}
                      onToggleForced={onToggleForced}
                      onToggleDisabled={onToggleDisabled}
                    />
                  )}
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
      {unreadable.map((network) => (
        <p key={network.network} className={styles.warn}>
          {network.label}: no se pudo leer ({network.error}). El plan no la usa.
        </p>
      ))}
    </section>
  );
}

function ProfileSelector({ analysis, profile, onProfileChange, orbitNetworks }) {
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h3 className={styles.title}>Holgura de gas</h3>
        <span className={styles.muted}>Aplica a todas las transacciones: bridges, approvals y el mint.</span>
      </header>
      <div className={styles.profiles} role="group" aria-label="Perfil de gas">
        {PROFILE_OPTIONS.map((option) => {
          const costs = analysis.costs.byProfile[option.id];
          const selected = option.id === profile;
          return (
            <button
              key={option.id}
              type="button"
              className={`${styles.profile} ${selected ? styles.profileOn : ''}`}
              aria-pressed={selected}
              onClick={() => onProfileChange?.(option.id)}
            >
              <span className={styles.profileHead}>
                <span className={styles.profileName}>{option.label}</span>
                <span className={styles.num}>{formatUsd(costs?.totalExpectedUsd)}</span>
              </span>
              <span className={styles.profileDesc}>{option.description}</span>
              <span className={styles.muted}>Máximo {formatUsd(costs?.totalMaxUsd)}</span>
            </button>
          );
        })}
      </div>
      {orbitNetworks.length > 0 && (
        <p className={styles.note}>
          En {orbitNetworks.join(' y ')} la priority fee es 0 (el secuenciador procesa por orden de llegada):
          ahí los perfiles solo cambian el margen y la reserva, no lo que pagas.
        </p>
      )}
    </section>
  );
}

function PlanSteps({ analysis, profile, labels }) {
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h3 className={styles.title}>Plan cross-chain</h3>
        <span className={styles.muted}>
          Faltan en {analysis.destination.label}{' '}
          <strong className={styles.num}>{formatUsd(analysis.destination.deficitUsd.token0)}</strong> y{' '}
          <strong className={styles.num}>{formatUsd(analysis.destination.deficitUsd.token1)}</strong> (por lado)
        </span>
      </header>
      {analysis.destination.lacksGas && (
        <p className={styles.note}>
          {analysis.destination.label} no tiene {analysis.destination.nativeSymbol} para el gas del LP: el envío marcado lo lleva y su red va primero.
        </p>
      )}
      <ol className={styles.steps}>
        {analysis.steps.map((step) => {
          const cost = step.costsByProfile?.[profile] || {};
          const source = labels[step.sourceNetwork] || step.sourceNetwork;
          return (
            <li key={step.order} className={styles.step} aria-label={`Paso ${step.order}: ${source} a ${analysis.destination.label}`}>
              <span className={styles.stepNum} aria-hidden="true">{step.order}</span>
              <div className={styles.stepBody}>
                <strong>{source} → {analysis.destination.label} · {step.token.symbol}</strong>
                <span className={styles.num}>
                  {formatAmount(step.amountRaw, step.token.decimals)} {step.token.symbol} → {formatAmount(step.receivedRaw, step.deliveryToken.decimals)} {step.deliveryToken.symbol}
                </span>
                <span className={styles.muted}>
                  {step.token.isNative ? 'Nativo · sale al final en su red' : 'ERC20 · sale antes que el nativo de su red'}
                  {step.carriesDestinationGas ? ' · lleva el gas de destino' : ''}
                  {step.forced ? ' · forzado' : ''}
                </span>
                <span className={styles.breakdown}>
                  <span>Gas origen <b className={styles.num}>{formatUsd(cost.gasOriginExpectedUsd)}</b></span>
                  <span>Bridge <b className={styles.num}>{formatUsd(step.costs.bridgeCostUsd)}</b></span>
                  {(step.costs.bridgeFees || []).map((fee) => (
                    <span key={fee.name} className={styles.muted}>{fee.name} {formatUsd(fee.amountUsd)}</span>
                  ))}
                </span>
                <span className={styles.muted}>
                  Ruta: {providerLabel(step.provider)}
                  {step.alternative ? ` · ${providerLabel(step.alternative.provider)} costaba ${formatUsd(step.alternative.costUsd)}` : ''}
                </span>
              </div>
              <div className={styles.stepCost}>
                <span className={styles.num}>{formatUsd(cost.expectedUsd)}</span>
                <span className={styles.muted}>máx. {formatUsd(cost.maxUsd)}</span>
              </div>
            </li>
          );
        })}
      </ol>
      {analysis.uncoveredUsd > 0 && (
        <p className={styles.warn}>
          Quedan {formatUsd(analysis.uncoveredUsd)} sin cubrir con orígenes viables. El LP se creará con lo que llegue.
        </p>
      )}
    </section>
  );
}

function CostSummary({ analysis, profile, canExecute, onUseRecommended, onBringFunds, busy }) {
  const selected = analysis.costs.byProfile[profile];
  const option = PROFILE_OPTIONS.find((entry) => entry.id === profile);
  const count = analysis.steps.length;
  const categories = [
    ['Gas en redes de origen', selected.gasOrigin, 'approvals y envíos'],
    ['Comisiones de bridge', { expectedUsd: selected.bridgeUsd, maxUsd: selected.bridgeUsd }, 'relayer, LP y agregador'],
    [`Gas en ${analysis.destination.label}`, selected.gasDestination, 'approvals y mint, con la L1'],
    ['Swaps en destino', selected.swaps, 'activos locales que se convierten'],
  ];
  return (
    <section className={styles.card}>
      <h3 className={styles.title}>Costos del proceso · perfil {option?.label.toLowerCase()}</h3>
      <div className={styles.categories}>
        {categories.map(([label, value, hint]) => (
          <div key={label} className={styles.category}>
            <span className={styles.muted}>{label}</span>
            <strong className={styles.num}>{formatUsd(value.expectedUsd)}</strong>
            <span className={styles.hint}>máx. {formatUsd(value.maxUsd)} · {hint}</span>
          </div>
        ))}
      </div>
      <div className={styles.totals}>
        <div>
          <span className={styles.muted}>Costo total esperado · máximo</span>
          <div className={styles.total}>
            <span className={styles.num} data-testid="cc-total-expected">{formatUsd(selected.totalExpectedUsd)}</span>
            <span className={styles.muted}> · {formatUsd(selected.totalMaxUsd)}</span>
          </div>
          <span className={styles.muted}>
            {formatPct(selected.pctOfTarget)} del capital · llega al LP <strong className={styles.num}>{formatUsd(analysis.deployableUsd)}</strong>
          </span>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onUseRecommended}>Usar recomendado</button>
          <button type="button" className={styles.primary} onClick={onBringFunds} disabled={!canExecute || busy || count === 0}>
            {`Traer fondos (${count} envío${count === 1 ? '' : 's'})`}
          </button>
        </div>
      </div>
      {!canExecute && (
        <p className={styles.note}>Este entorno está en modo solo análisis: los bridges no se pueden ejecutar desde aquí.</p>
      )}
      <p className={styles.hint}>
        El esperado es lo que se paga con el gas actual; el máximo es el tope que se deja de reserva en cada red.
        Antes de firmar cada envío se vuelve a cotizar.
      </p>
    </section>
  );
}

/**
 * Panel del paso Fondeo con los saldos multi-red, el perfil de gas, el plan
 * de bridges y sus costos. Presentacional: el estado vive en
 * `useCrossChainFunding`.
 */
export default function CrossChainFundingPanel({
  analysis,
  profile,
  onProfileChange,
  forcedSources = [],
  disabledSources = [],
  onToggleForced,
  onToggleDisabled,
  onUseRecommended,
  onBringFunds,
  canExecute = false,
  loading = false,
  error = null,
  busy = false,
}) {
  if (error) return <p className={styles.warn} role="alert">{error}</p>;
  if (!analysis) return loading ? <p className={styles.muted}>Leyendo saldos en todas las redes…</p> : null;

  const labels = Object.fromEntries(analysis.balances.networks.map((network) => [network.network, network.label]));
  const orbitNetworks = [...new Set(analysis.steps
    .filter((step) => step.costs?.gasOrigin?.profilesMatter === false)
    .map((step) => labels[step.sourceNetwork] || step.sourceNetwork))];

  return (
    <div className={styles.panel} aria-busy={loading}>
      <BalancesTable
        analysis={analysis}
        forcedSources={forcedSources}
        disabledSources={disabledSources}
        onToggleForced={onToggleForced}
        onToggleDisabled={onToggleDisabled}
      />
      {!analysis.needsCrossChain ? (
        <p className={styles.note}>Los fondos alcanzan en {analysis.destination.label}: no hace falta traer nada de otras redes.</p>
      ) : (
        <>
          <ProfileSelector analysis={analysis} profile={profile} onProfileChange={onProfileChange} orbitNetworks={orbitNetworks} />
          <PlanSteps analysis={analysis} profile={profile} labels={labels} />
          <CostSummary
            analysis={analysis}
            profile={profile}
            canExecute={canExecute}
            onUseRecommended={onUseRecommended}
            onBringFunds={onBringFunds}
            busy={busy}
          />
        </>
      )}
    </div>
  );
}

import Sparkline from './Sparkline';
import OrchestratorMetricChart from './OrchestratorMetricChart';
import { fmtSignedUsd, fmtUsdCompact } from '../lib/format';
import styles from '../MetricasPage.module.css';

const LIQ_DANGER_PCT = 10;
const LIQ_WARN_PCT = 20;

function Chevron({ open }) {
  return (
    <svg
      className={styles.rowChevron}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={open ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  );
}

export default function OrchestratorRow({ row, range, expanded, onToggle, loading = false }) {
  const { orchestrator, rangePnlUsd, distanceToLiqPct } = row;
  const pnlTone = rangePnlUsd == null ? '' : (rangePnlUsd >= 0 ? styles.statDeltaPos : styles.statDeltaNeg);
  const liqTone = distanceToLiqPct == null
    ? ''
    : (distanceToLiqPct < LIQ_DANGER_PCT
      ? styles.toneDanger
      : (distanceToLiqPct < LIQ_WARN_PCT ? styles.toneWarn : ''));
  const label = `${orchestrator.name} · ${orchestrator.token0Symbol}/${orchestrator.token1Symbol}`;

  return (
    <div className={`${styles.row} ${expanded ? styles.rowExpanded : ''}`}>
      <button
        type="button"
        className={styles.rowHeader}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={styles.rowIdentity}>
          <Chevron open={expanded} />
          <span className={styles.rowName}>{label}</span>
          <span className={styles.rowMeta}>
            {orchestrator.network} · {orchestrator.version}
          </span>
          {row.error && <span className={`${styles.rowBadge} ${styles.rowBadgeDanger}`}>Error</span>}
          {/* Mientras la serie viaja, la fila no sabe todavia si hay snapshots:
              decir que no los hay seria mentir durante la carga. */}
          {!row.error && !row.snapshotCount && !loading && (
            <span className={styles.rowBadge}>Sin snapshots aún</span>
          )}
          {orchestrator.activeProtectedPoolId == null && (
            <span className={styles.rowBadge}>Sin cobertura</span>
          )}
          {distanceToLiqPct != null && distanceToLiqPct < LIQ_WARN_PCT && (
            <span className={`${styles.rowBadge} ${distanceToLiqPct < LIQ_DANGER_PCT ? styles.rowBadgeDanger : styles.rowBadgeWarn}`}>
              Margen bajo
            </span>
          )}
        </span>

        <span className={styles.rowSpark}>
          <Sparkline
            values={row.sparkline}
            stroke={rangePnlUsd != null && rangePnlUsd < 0 ? '#ef4444' : '#22c55e'}
            ariaLabel={`Tendencia de ${label} en ${range?.label || 'el rango'}`}
          />
        </span>

        <span className={styles.rowNumber}>{fmtUsdCompact(row.capitalUsd)}</span>
        <span className={`${styles.rowNumber} ${styles.rowNumberStrong} ${pnlTone}`}>
          {rangePnlUsd == null ? '—' : fmtSignedUsd(rangePnlUsd)}
        </span>
        <span className={`${styles.rowNumber} ${liqTone}`}>
          {distanceToLiqPct == null ? '—' : `${distanceToLiqPct.toFixed(1)}%`}
        </span>
      </button>

      {expanded && (
        <div className={styles.rowDetail}>
          <OrchestratorMetricChart
            orchestrator={orchestrator}
            range={range}
            snapshots={row.snapshots}
            error={row.error}
          />
        </div>
      )}
    </div>
  );
}

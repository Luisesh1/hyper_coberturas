import { useMemo } from 'react';
import LineChart, { ChartLegend } from '../strategies/common/LineChart';
import { formatDateTime, formatDay, formatMonthYear, formatUsdt, tone } from '../strategies/common/format';
import { DownloadIcon, InfoIcon } from '../strategies/common/icons';
import {
  buildBacktestEquity, buildMetrics, cyclesToCsv, downloadCsv, normalizeCycles, sourceByKey,
} from './backtestView';
import ui from '../strategies/common/ui.module.css';
import styles from './BacktestingTab.module.css';

const toneClass = (v) => ui[`tone_${tone(v) === 'neutral' ? 'muted' : tone(v)}`];

export function SourceNote({ source, note, mobile = false }) {
  const src = sourceByKey(source);
  const text = note || (mobile ? src.noteShort : src.note);
  if (mobile) return <p className={styles.mobileNote}>{text}</p>;
  return (
    <p className={`${ui.alert} ${ui.alertInfo}`}>
      <InfoIcon size={18} />
      <span>{text}</span>
    </p>
  );
}

function EquityChart({ result, underlying, height }) {
  const eq = useMemo(() => buildBacktestEquity(result?.equity), [result]);
  const hodlLabel = `Mantener ${underlying || 'subyacente'}`;
  return (
    <LineChart
      times={eq.times}
      series={[
        { key: 'strategy', label: 'Estrategia', values: eq.strategy, variant: 'primary' },
        { key: 'hodl', label: hodlLabel, values: eq.hodl, variant: 'muted', dashed: true },
      ]}
      height={height}
      formatValue={(v) => formatUsdt(v, { decimals: 0 })}
      formatTime={(t) => (height < 150 ? formatDay(t) : formatMonthYear(t))}
      ariaLabel={`Curva de capital del backtest comparada con ${hodlLabel.toLowerCase()}`}
      emptyText="El backtest no generó curva de capital."
    />
  );
}

function exportCsv(run) {
  const cfg = run.config || {};
  const name = `backtest-${run.id ?? 'opciones'}-${(cfg.underlying || '').toLowerCase() || 'x'}.csv`;
  downloadCsv(name, cyclesToCsv(run.result?.cycles));
}

export function RunProgress({ run, mobile }) {
  return (
    <div className={`${ui.panel} ${styles.progress}`} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <div className={styles.progressText}>
        <strong>{run.status === 'queued' ? 'Backtest en cola…' : 'Ejecutando backtest…'}</strong>
        <span className={ui.muted}>
          {mobile ? 'Se actualiza solo.' : 'Se actualiza solo cada pocos segundos; puedes cambiar de pestaña.'}
        </span>
      </div>
    </div>
  );
}

export default function BacktestResults({ run, mobile = false }) {
  const result = run.result || {};
  const cfg = run.config || {};
  const metrics = useMemo(() => buildMetrics(result.metrics), [result.metrics]);
  const cycles = useMemo(() => normalizeCycles(result.cycles), [result.cycles]);
  const hodlLabel = `Mantener ${cfg.underlying || 'subyacente'}`;

  const exportBtn = (
    <button
      type="button"
      className={`${ui.btn} ${mobile ? '' : ui.btnSmall}`}
      onClick={() => exportCsv(run)}
      disabled={!cycles.length}
    >
      <DownloadIcon size={16} /> Exportar CSV
    </button>
  );

  if (mobile) {
    return (
      <>
        <SourceNote source={cfg.source} note={result.sourceNote} mobile />
        <div className={ui.tileGrid}>
          {metrics.slice(0, 4).map((m) => (
            <div key={m.key} className={ui.tile}>
              <span className={ui.tileLabel}>{m.shortLabel || m.label}</span>
              <span className={`${ui.tileValue} ${ui[`tone_${m.tone}`]}`}>{m.value}</span>
            </div>
          ))}
        </div>
        <div className={ui.panel} style={{ padding: 12 }}>
          <ChartLegend items={[{ label: 'Estrategia', variant: 'primary' }, { label: hodlLabel, variant: 'muted', dashed: true }]} />
          <EquityChart result={result} underlying={cfg.underlying} height={120} />
        </div>
        <div className={styles.mobileHead}>
          <h2 className={styles.mobileH2}>Ciclos <span className={ui.muted}>({cycles.length})</span></h2>
          {exportBtn}
        </div>
        {!cycles.length && <p className={ui.empty}>Sin ciclos en el periodo.</p>}
        <ul className={styles.cycleCards}>
          {cycles.map((c) => (
            <li key={c.id} className={styles.cycleCard}>
              <span className={styles.cycleMain}>
                <span className={`${ui.mono} ${styles.cycleDates}`}>{formatDay(c.openedAt)} → {formatDay(c.expiry)}</span>
                <span className={styles.cycleExit}>{c.exitReason || '—'}</span>
              </span>
              <span className={`${ui.mono} ${styles.cyclePnl} ${toneClass(c.pnl)}`}>{formatUsdt(c.pnl, { sign: true })}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      <SourceNote source={cfg.source} note={result.sourceNote} />
      <div className={ui.kpiGrid}>
        {metrics.map((m) => (
          <div key={m.key} className={ui.kpi}>
            <span className={ui.kpiLabel}>{m.label}</span>
            <span className={`${ui.kpiValue} ${ui[`tone_${m.tone}`]}`} style={{ fontSize: 18 }}>{m.value}</span>
          </div>
        ))}
      </div>
      <div className={ui.panel}>
        <div className={ui.panelHead}>
          <h3 className={ui.h3}>Capital de la estrategia vs mantener el subyacente</h3>
          <ChartLegend items={[{ label: 'Estrategia', variant: 'primary' }, { label: hodlLabel, variant: 'muted', dashed: true }]} />
        </div>
        <EquityChart result={result} underlying={cfg.underlying} height={220} />
      </div>
      <div className={`${ui.panel} ${ui.panelFlush}`}>
        <div className={ui.panelHead}>
          <h3 className={ui.h3}>Ciclos <span className={ui.muted}>({cycles.length})</span></h3>
          {exportBtn}
        </div>
        {!cycles.length ? <p className={ui.empty}>Sin ciclos en el periodo.</p> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr><th>Apertura</th><th>Vencimiento</th><th>Patas</th><th className={ui.num}>Prima</th><th>Salida</th><th className={ui.num}>P&amp;L</th></tr>
              </thead>
              <tbody>
                {cycles.map((c) => (
                  <tr key={c.id}>
                    <td className={ui.mono} style={{ whiteSpace: 'nowrap' }}>{formatDateTime(c.openedAt)}</td>
                    <td className={ui.mono} style={{ whiteSpace: 'nowrap' }}>{formatDay(c.expiry)}</td>
                    <td className={`${ui.mono} ${styles.legsCell}`}>{c.legsText}</td>
                    <td className={`${ui.mono} ${ui.num}`}>{c.premium === null ? '—' : formatUsdt(c.premium, { sign: true })}</td>
                    <td>{c.exitReason || '—'}</td>
                    <td className={`${ui.mono} ${ui.num} ${toneClass(c.pnl)}`}>{formatUsdt(c.pnl, { sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

import { formatNumber, formatPct, formatUsdt, tone } from '../../strategies/common/format';
import { MIN_TRADES_FOR_WIN_RATE } from '../botView';
import styles from './visual.module.css';

const W = 200;
const H = 40;
const n2 = (v) => formatNumber(v, { decimals: 2, minDecimals: 0 });
const signed = (v) => (Number.isFinite(v) ? formatUsdt(v, { sign: true }) : '—');
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const toneClass = (v) => styles[`t_${tone(v)}`];

function Card({ label, children, className = '' }) {
  return (
    <div className={`${styles.kpi} ${className}`}>
      <span className={styles.kpiLabel}>{label}</span>
      {children}
    </div>
  );
}

// Curva real frente a sombra: el libro activo sólido con área, el otro a trazos.
function PnlCurve({ pnl, mode, height = H, emptyText = 'Sin operaciones cerradas en 30 días' }) {
  const { live, shadow } = pnl.curve;
  const all = [...live, ...shadow].map((p) => p.y);
  if (!all.length) return <div className={styles.curveEmpty} style={{ height }}>{emptyText}</div>;
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const span = max - min || 1;
  const xy = (p) => `${(p.x * W).toFixed(1)},${(2 + ((max - p.y) / span) * (H - 4)).toFixed(1)}`;
  const line = (pts) => pts.map(xy).join(' ');
  const activePts = mode === 'live' ? live : shadow;
  const otherPts = mode === 'live' ? shadow : live;
  const otherMode = mode === 'live' ? 'shadow' : 'live';
  const label = [
    live.length || pnl.live !== null ? `real ${signed(pnl.live)}` : null,
    `sombra ${signed(pnl.shadow)}`,
  ].filter(Boolean).join(', ');
  return (
    <svg className={styles.curve} viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={`Curva de P&L 30 días: ${label}`}>
      {activePts.length > 1 && (
        <path className={styles[`area_${mode}`]} d={`M${xy(activePts[0])} L${line(activePts.slice(1))} L${W},${H} L0,${H} Z`} />
      )}
      {otherPts.length > 1 && (
        <polyline className={`${styles.curveLine} ${styles[`line_${otherMode}`]} ${styles.lineDashed}`} points={line(otherPts)} />
      )}
      {activePts.length > 1 && <polyline className={`${styles.curveLine} ${styles[`line_${mode}`]}`} points={line(activePts)} />}
    </svg>
  );
}

function PnlCard({ pnl, mode, compact }) {
  const showLive = mode === 'live' || pnl.curve.live.length > 0 || pnl.live !== null;
  return (
    <Card label="P&L neto 30 d">
      <span className={`${styles.kpiValue} ${toneClass(pnl.value)}`}>{signed(pnl.value)}</span>
      {compact
        ? <PnlCurve pnl={pnl} mode={mode} height={28} emptyText="Sin cerradas en 30 d" />
        : <PnlCurve pnl={pnl} mode={mode} />}
      {!compact && (
        <div className={styles.split}>
          {showLive && <span className={styles.leg_live}>— real {signed(pnl.live)}</span>}
          <span className={styles.leg_shadow}>- - sombra {signed(pnl.shadow)}</span>
        </div>
      )}
    </Card>
  );
}

function WinRing({ pct }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, pct ?? 0)) / 100;
  return (
    <svg className={styles.winRing} width="54" height="54" viewBox="0 0 54 54" role="img"
      aria-label={pct === null ? 'Acierto sin datos suficientes' : `${formatPct(pct, { decimals: 1 })} de acierto`}>
      <circle cx="27" cy="27" r={r} className={pct === null ? styles.winTrackEmpty : styles.winTrack} />
      {pct !== null && (
        <circle cx="27" cy="27" r={r} className={styles.winFill} strokeDasharray={c.toFixed(1)} strokeDashoffset={(c * (1 - p)).toFixed(1)} transform="rotate(-90 27 27)" />
      )}
    </svg>
  );
}

function WinCard({ win, compact }) {
  let value = win.pct === null ? '—' : formatPct(win.pct, { decimals: 1 });
  let sub = win.wins !== null && win.total ? `${win.wins} de ${win.total} operaciones` : 'Sin operaciones cerradas';
  if (win.few) {
    value = 'n/a';
    sub = `${plural(win.closedTrades, 'cerrada', 'cerradas')} · mínimo ${MIN_TRADES_FOR_WIN_RATE} operaciones cerradas`;
  }
  const extra = [
    win.avg !== null ? `Media ${signed(win.avg)}` : null,
    win.drawdown !== null && win.drawdown > 0 ? `peor racha ${signed(-win.drawdown)}` : null,
  ].filter(Boolean).join(' · ');
  if (compact) {
    const p = Math.min(100, Math.max(0, win.pct ?? 0));
    const short = win.few ? `${plural(win.closedTrades, 'cerrada', 'cerradas')} · mín. ${MIN_TRADES_FOR_WIN_RATE}`
      : win.wins !== null && win.total ? `${win.wins} de ${win.total}` : 'Sin cerradas';
    return (
      <Card label="Acierto">
        <span className={styles.kpiValue}>{value}</span>
        <div className={styles.meter} role="img"
          aria-label={win.pct === null ? 'Acierto sin datos suficientes' : `${formatPct(win.pct, { decimals: 1 })} de acierto`}>
          {win.pct !== null && <><i className={styles.meterWin} style={{ width: `${p}%` }} /><i className={styles.meterLoss} style={{ width: `${100 - p}%` }} /></>}
        </div>
        <span className={styles.kpiSub}>{short}</span>
      </Card>
    );
  }
  return (
    <Card label="Acierto">
      <div className={styles.winRow}>
        <WinRing pct={win.pct} />
        <div className={styles.winText}>
          <span className={styles.kpiValue}>{value}</span>
          <span className={styles.kpiSub}>{sub}</span>
        </div>
      </div>
      {!compact && extra && <span className={styles.kpiSub}>{extra}</span>}
    </Card>
  );
}

function FeesCard({ fees, compact }) {
  const pct = fees.pct;
  let sub = fees.label ? `${fees.label}${fees.premium ? ` (${n2(fees.premium)} USDT)` : ''}` : 'Sin prima operada todavía';
  if (compact) sub = pct !== null ? `${formatPct(pct, { decimals: 1 })} de la prima` : 'Sin prima operada';
  const total = fees.total === null ? '—' : `${formatUsdt(fees.total)}${compact ? '' : ' USDT'}`;
  return (
    <Card label={compact ? 'Comisiones' : 'Comisiones totales'}>
      <span className={`${styles.kpiValue} ${styles.t_fee}`}>{total}</span>
      <div className={styles.meter} role="img" aria-label={pct === null ? 'Comisiones sin prima operada' : `Comisiones: ${fees.label}`}>
        {pct !== null && <i className={styles.meterFee} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 1.5 : 0, pct))}%` }} />}
      </div>
      <span className={styles.kpiSub}>{sub}</span>
      {!compact && fees.parts.length > 0 && (
        <div className={`${styles.split} ${styles.splitWrap}`}>
          {fees.parts.map((p) => <span key={p.key}>{p.label} {formatUsdt(p.usdt)}</span>)}
        </div>
      )}
    </Card>
  );
}

function BudgetCard({ budget: b, compact }) {
  const counts = [
    b.openCount || !b.pendingCount ? plural(b.openCount, 'posición', 'posiciones') : null,
    b.pendingCount ? plural(b.pendingCount, 'entrada pendiente', 'entradas pendientes') : null,
  ].filter(Boolean).join(' + ');
  const free = b.freeFractions !== null ? plural(b.freeFractions, 'fracción libre', 'fracciones libres') : null;
  const sub = compact && free ? free : `${counts}${free ? ` · ${free}` : ''}`;
  const pct = (v) => `${Math.min(100, Math.max(0, (v / b.budget) * 100))}%`;
  return (
    <Card label="Presupuesto">
      {b.budget !== null ? (
        <>
          <span className={styles.kpiValue}>{n2(b.used)} <span className={styles.kpiValueSub}>/ {n2(b.budget)}{compact ? '' : ' USDT'}</span></span>
          <div className={styles.meter} role="img" aria-label={`Presupuesto: ${n2(b.used)} usado y ${n2(b.reserved)} reservado de ${n2(b.budget)} USDT`}>
            <i className={styles.meterUsed} style={{ width: pct(b.used) }} />
            <i className={styles.meterReserved} style={{ width: pct(b.reserved) }} />
          </div>
        </>
      ) : (
        <span className={styles.kpiValue}>{n2(b.used + b.reserved)} <span className={styles.kpiValueSub}>{compact ? 'USDT' : 'USDT · sin presupuesto total'}</span></span>
      )}
      <span className={styles.kpiSub}>{sub}</span>
      {!compact && (
        <div className={styles.split}>
          <span>Operaciones hoy {b.ordersToday} / {b.maxTrades ?? '—'}</span>
          <span>Posiciones {b.openCount} / {b.maxOpen ?? '—'}</span>
        </div>
      )}
    </Card>
  );
}

/**
 * Cuatro KPIs con forma: P&L neto con curva real frente a sombra, anillo de
 * acierto, comisiones con barra y desglose, y presupuesto usado/reservado.
 * `model` sale de kpiCardsModel(bot). `compact` (teléfono): rejilla 2×2 con
 * mini curva y barras, sin desgloses ni leyendas.
 */
export default function KpiCards({ model, compact = false }) {
  if (!model) return null;
  return (
    <div className={`${styles.kpis} ${compact ? styles.kpisCompact : ''}`}>
      <PnlCard pnl={model.pnl} mode={model.mode} compact={compact} />
      <WinCard win={model.win} compact={compact} />
      <FeesCard fees={model.fees} compact={compact} />
      <BudgetCard budget={model.budget} compact={compact} />
    </div>
  );
}

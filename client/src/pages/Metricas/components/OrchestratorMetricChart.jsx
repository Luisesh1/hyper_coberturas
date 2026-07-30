import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  createChart,
} from 'lightweight-charts';
import { metricsApi } from '../../../services/api';
import styles from '../MetricasPage.module.css';

const COLOR_TOTAL = '#38bdf8';
const COLOR_WALLET = '#a78bfa';
const COLOR_LP = '#22c55e';
const COLOR_HL = '#f59e0b';

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toChartTime(ms) {
  // lightweight-charts acepta segundos UTC como `time`
  return Math.floor(Number(ms) / 1000);
}

function fmtDateTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtSignedUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}${fmtUsd(Math.abs(n))}`;
}

// Componentes del PnL neto, en el mismo orden y con el mismo signo con que
// `server/src/services/lp-orchestrator/accounting.js` los suma en
// recomputeNetPnl(). `sign` es la contribucion al total (los costos restan).
const PNL_COMPONENTS = [
  { key: 'lpFeesUsd', label: 'Fees LP', sign: 1 },
  { key: 'priceDriftUsd', label: 'Deriva de precio LP', sign: 1 },
  { key: 'hedgeRealizedPnlUsd', label: 'Hedge realizado', sign: 1 },
  { key: 'hedgeUnrealizedPnlUsd', label: 'Hedge no realizado', sign: 1 },
  { key: 'hedgeFundingUsd', label: 'Funding', sign: 1 },
  { key: 'gasSpentUsd', label: 'Gas', sign: -1 },
  { key: 'swapSlippageUsd', label: 'Slippage swaps', sign: -1 },
  { key: 'hedgeExecutionFeesUsd', label: 'Fees ejecucion hedge', sign: -1 },
  { key: 'hedgeSlippageUsd', label: 'Slippage hedge', sign: -1 },
];

/**
 * Desglose legible del PnL para el tooltip nativo del stat. Incluye los
 * ajustes de capital (depositos/retiros al LP) como nota aparte: NO son PnL,
 * pero explican por que "Δ rango" y "PnL total" pueden diferir.
 */
function buildPnlTooltip(accounting, rangeDeltaUsd, rangeLabel) {
  if (!accounting) return 'Sin contabilidad disponible';
  const lines = ['PnL neto acumulado (vida del orquestador)', ''];
  for (const { key, label, sign } of PNL_COMPONENTS) {
    const raw = Number(accounting[key]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    lines.push(`${label}: ${fmtSignedUsd(sign * raw)}`);
  }
  lines.push('', `Total: ${fmtSignedUsd(accounting.totalNetPnlUsd)}`);
  if (Number.isFinite(rangeDeltaUsd)) {
    lines.push(`PnL en ${rangeLabel}: ${fmtSignedUsd(rangeDeltaUsd)}`);
  }
  const capital = Number(accounting.capitalAdjustmentsUsd);
  if (Number.isFinite(capital) && capital !== 0) {
    lines.push('', `Capital agregado/retirado (no es PnL): ${fmtSignedUsd(capital)}`);
  }
  return lines.join('\n');
}

export default function OrchestratorMetricChart({ orchestrator, range }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Valores live on-chain — fetcheados on-demand via boton de refresh.
  // NO se persisten (no crean snapshot), solo sobrescriben el header.
  const [liveStats, setLiveStats] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Load historical snapshots
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const now = Date.now();
    const startAt = range?.ms ? now - range.ms : null;

    metricsApi.getSnapshots(orchestrator.id, {
      startAt,
      endAt: now,
      limit: 5000,
    }).then((data) => {
      if (cancelled) return;
      setSnapshots(Array.isArray(data) ? data : []);
    }).catch((err) => {
      if (cancelled) return;
      setError(err?.message || 'Error cargando metricas');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [orchestrator.id, range?.id, range?.ms]);

  // Cambiar de orchestrator o rango descarta el override live.
  useEffect(() => {
    setLiveStats(null);
  }, [orchestrator.id, range?.id, range?.ms]);

  // Derived stats. Si el usuario presiono "Refrescar", priorizamos liveStats
  // (valores on-chain actuales) para el header; el delta se sigue calculando
  // contra el primer snapshot del rango.
  const stats = useMemo(() => {
    if (!snapshots.length && !liveStats) {
      return { current: null, first: null, deltaUsd: 0, deltaPct: 0, isLive: false };
    }
    const first = snapshots[0] || null;
    const snapCurrent = snapshots[snapshots.length - 1] || null;
    const current = liveStats || snapCurrent;
    const baselineTotal = first ? Number(first.totalUsd) : (current ? Number(current.totalUsd) : 0);
    const deltaUsd = current ? Number(current.totalUsd) - baselineTotal : 0;
    const deltaPct = baselineTotal > 0 ? (deltaUsd / baselineTotal) * 100 : 0;
    return { current, first, deltaUsd, deltaPct, isLive: Boolean(liveStats) };
  }, [snapshots, liveStats]);

  // PnL neto acumulado. La fuente de verdad es la contabilidad del propio
  // orquestador (se refresca con el poll de la pagina); los snapshots solo
  // aportan la baseline para acotar el PnL a la ventana seleccionada.
  const pnl = useMemo(() => {
    const accounting = liveStats?.accounting
      || orchestrator.accounting
      || stats.current?.breakdown?.accounting
      || null;
    if (!accounting || !Number.isFinite(Number(accounting.totalNetPnlUsd))) {
      return { accounting: null, totalUsd: null, rangeUsd: null };
    }
    const totalUsd = Number(accounting.totalNetPnlUsd);
    // Snapshots anteriores a este cambio no llevan `accounting`; en ese caso
    // no hay baseline y omitimos el PnL del rango en vez de inventarlo.
    const baseline = Number(stats.first?.breakdown?.accounting?.totalNetPnlUsd);
    return {
      accounting,
      totalUsd,
      rangeUsd: Number.isFinite(baseline) ? totalUsd - baseline : null,
    };
    // `stats` ya es un useMemo: su referencia solo cambia cuando cambian los
    // snapshots o el live, asi que alcanza con depender del objeto entero.
  }, [liveStats, orchestrator.accounting, stats]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const data = await metricsApi.getCurrent(orchestrator.id);
      if (data && data.totalUsd != null) {
        setLiveStats({
          capturedAt: data.capturedAt || Date.now(),
          totalUsd: data.totalUsd,
          walletUsd: data.walletUsd,
          lpUsd: data.lpUsd,
          hlAccountUsd: data.hlAccountUsd,
          hedgeTracking: data.breakdown?.hedgeTracking || null,
          accounting: data.breakdown?.accounting || null,
        });
      }
    } catch (err) {
      setError(err?.message || 'Error refrescando');
    } finally {
      setRefreshing(false);
    }
  };

  // Render chart
  useEffect(() => {
    if (!containerRef.current) return;
    if (!snapshots.length) {
      // Clean any previous chart when data disappears
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      return;
    }

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#cbd5e1',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;

    const totalData = snapshots.map((s) => ({
      time: toChartTime(s.capturedAt),
      value: Number(s.totalUsd) || 0,
    }));

    // Area de fondo = total acumulado
    const area = chart.addSeries(AreaSeries, {
      lineColor: COLOR_TOTAL,
      topColor: 'rgba(56, 189, 248, 0.28)',
      bottomColor: 'rgba(56, 189, 248, 0.02)',
      lineWidth: 3,
      priceLineVisible: true,
    });
    area.setData(totalData);

    // Lineas desglosadas superpuestas
    const walletSeries = chart.addSeries(LineSeries, {
      color: COLOR_WALLET, lineWidth: 2, priceLineVisible: false,
    });
    walletSeries.setData(snapshots.map((s) => ({
      time: toChartTime(s.capturedAt),
      value: Number(s.walletUsd) || 0,
    })));

    const lpSeries = chart.addSeries(LineSeries, {
      color: COLOR_LP, lineWidth: 2, priceLineVisible: false,
    });
    lpSeries.setData(snapshots.map((s) => ({
      time: toChartTime(s.capturedAt),
      value: Number(s.lpUsd) || 0,
    })));

    const hlSeries = chart.addSeries(LineSeries, {
      color: COLOR_HL, lineWidth: 2, priceLineVisible: false,
    });
    hlSeries.setData(snapshots.map((s) => ({
      time: toChartTime(s.capturedAt),
      value: Number(s.hlAccountUsd) || 0,
    })));

    chart.timeScale().fitContent();

    // --- Tooltip on hover ---
    // Index por timestamp (segundos UTC) para lookup O(1) en cada movimiento.
    const byTime = new Map();
    for (const s of snapshots) {
      byTime.set(toChartTime(s.capturedAt), s);
    }
    const tooltipEl = tooltipRef.current;
    const containerEl = containerRef.current;

    const handleCrosshair = (param) => {
      if (!tooltipEl || !containerEl) return;
      if (
        !param.point
        || param.time == null
        || param.point.x < 0 || param.point.y < 0
        || param.point.x > containerEl.clientWidth
        || param.point.y > containerEl.clientHeight
      ) {
        tooltipEl.style.display = 'none';
        return;
      }

      const snap = byTime.get(Number(param.time));
      if (!snap) {
        tooltipEl.style.display = 'none';
        return;
      }

      tooltipEl.innerHTML = `
        <div class="${styles.tooltipDate}">${fmtDateTime(snap.capturedAt)}</div>
        <div class="${styles.tooltipRow}">
          <span><span class="${styles.legendSwatch}" style="background:${COLOR_TOTAL}"></span>Total</span>
          <strong>${fmtUsd(snap.totalUsd)}</strong>
        </div>
        <div class="${styles.tooltipRow}">
          <span><span class="${styles.legendSwatch}" style="background:${COLOR_WALLET}"></span>Wallet</span>
          <strong>${fmtUsd(snap.walletUsd)}</strong>
        </div>
        <div class="${styles.tooltipRow}">
          <span><span class="${styles.legendSwatch}" style="background:${COLOR_LP}"></span>LP</span>
          <strong>${fmtUsd(snap.lpUsd)}</strong>
        </div>
        <div class="${styles.tooltipRow}">
          <span><span class="${styles.legendSwatch}" style="background:${COLOR_HL}"></span>HL</span>
          <strong>${fmtUsd(snap.hlAccountUsd)}</strong>
        </div>
      `;
      tooltipEl.style.display = 'block';

      // Posicionar tooltip cerca del cursor sin salir del contenedor.
      const tooltipWidth = tooltipEl.offsetWidth || 180;
      const tooltipHeight = tooltipEl.offsetHeight || 100;
      const margin = 12;
      let left = param.point.x + margin;
      if (left + tooltipWidth + margin > containerEl.clientWidth) {
        left = param.point.x - tooltipWidth - margin;
      }
      let top = param.point.y + margin;
      if (top + tooltipHeight + margin > containerEl.clientHeight) {
        top = param.point.y - tooltipHeight - margin;
      }
      if (left < 0) left = margin;
      if (top < 0) top = margin;
      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.top = `${top}px`;
    };

    chart.subscribeCrosshairMove(handleCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshair);
      chart.remove();
      chartRef.current = null;
      if (tooltipEl) tooltipEl.style.display = 'none';
    };
  }, [snapshots]);

  const deltaClass = stats.deltaUsd >= 0 ? styles.statDeltaPos : styles.statDeltaNeg;
  const deltaSign = stats.deltaUsd >= 0 ? '+' : '';
  const pnlClass = pnl.totalUsd == null
    ? ''
    : (pnl.totalUsd >= 0 ? styles.statDeltaPos : styles.statDeltaNeg);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardHeaderLeft}>
          <h3 className={styles.cardTitle}>
            {orchestrator.name} · {orchestrator.token0Symbol}/{orchestrator.token1Symbol}
          </h3>
          <span className={styles.cardMeta}>
            {orchestrator.network} · {orchestrator.version}
            {orchestrator.accountId != null ? ' · hedge activo' : ' · sin hedge'}
            {' · '}
            {orchestrator.status}
            {stats.isLive && (
              <span className={styles.liveBadge} title={`Datos live de ${fmtDateTime(stats.current?.capturedAt)}`}>
                {' · live'}
              </span>
            )}
          </span>
        </div>
        <div className={styles.cardStats}>
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={handleRefresh}
            disabled={refreshing}
            title="Consulta on-chain al momento — no persiste snapshot"
          >
            {refreshing ? '⟳ Refrescando…' : '⟳ Refrescar'}
          </button>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Total actual</span>
            <span className={styles.statValue}>
              {stats.current ? fmtUsd(stats.current.totalUsd) : '—'}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Wallet Arb</span>
            <span className={styles.statValue} style={{ color: COLOR_WALLET }}>
              {stats.current ? fmtUsd(stats.current.walletUsd) : '—'}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>LP</span>
            <span className={styles.statValue} style={{ color: COLOR_LP }}>
              {stats.current ? fmtUsd(stats.current.lpUsd) : '—'}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Hyperliquid</span>
            <span className={styles.statValue} style={{ color: COLOR_HL }}>
              {stats.current ? fmtUsd(stats.current.hlAccountUsd) : '—'}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Δ rango</span>
            <span className={`${styles.statValue} ${deltaClass}`}>
              {stats.first
                ? `${deltaSign}${fmtUsd(stats.deltaUsd)} (${deltaSign}${stats.deltaPct.toFixed(2)}%)`
                : '—'}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>PnL total</span>
            <span
              className={`${styles.statValue} ${pnlClass}`}
              title={buildPnlTooltip(pnl.accounting, pnl.rangeUsd, range?.label || 'el rango')}
            >
              {pnl.totalUsd != null ? fmtSignedUsd(pnl.totalUsd) : '—'}
            </span>
          </div>
          {stats.current?.hedgeTracking?.hasHedge && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Funding/día</span>
              <span
                className={styles.statValue}
                style={{ color: stats.current.hedgeTracking.fundingHeadwind ? '#e2554e' : '#3fb27f' }}
                title={stats.current.hedgeTracking.fundingHeadwind
                  ? 'El hedge corto está PAGANDO funding (headwind)'
                  : 'El hedge corto COBRA funding'}
              >
                {stats.current.hedgeTracking.projectedDailyFundingUsd != null
                  ? `${stats.current.hedgeTracking.projectedDailyFundingUsd >= 0 ? '+' : ''}${fmtUsd(stats.current.hedgeTracking.projectedDailyFundingUsd)}`
                  : '—'}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.legend}>
        <span><span className={styles.legendSwatch} style={{ background: COLOR_TOTAL }} />Total acumulado</span>
        <span><span className={styles.legendSwatch} style={{ background: COLOR_WALLET }} />Wallet Arbitrum</span>
        <span><span className={styles.legendSwatch} style={{ background: COLOR_LP }} />LP Uniswap</span>
        <span><span className={styles.legendSwatch} style={{ background: COLOR_HL }} />Hyperliquid</span>
      </div>

      <div className={styles.chartContainer} ref={containerRef}>
        <div ref={tooltipRef} className={styles.chartTooltip} style={{ display: 'none' }} />
        {loading && <div className={styles.loading}>Cargando…</div>}
        {error && <div className={styles.empty}>Error: {error}</div>}
        {!loading && !error && !snapshots.length && (
          <div className={styles.empty}>
            Aun no hay snapshots para este orquestador. El primero se capturara en la
            proxima hora en punto.
          </div>
        )}
      </div>
    </div>
  );
}

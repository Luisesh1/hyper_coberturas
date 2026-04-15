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

export default function OrchestratorMetricChart({ orchestrator, range }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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

  // Derived stats
  const stats = useMemo(() => {
    if (!snapshots.length) {
      return { current: null, first: null, deltaUsd: 0, deltaPct: 0 };
    }
    const first = snapshots[0];
    const current = snapshots[snapshots.length - 1];
    const deltaUsd = Number(current.totalUsd) - Number(first.totalUsd);
    const deltaPct = first.totalUsd > 0 ? (deltaUsd / Number(first.totalUsd)) * 100 : 0;
    return { current, first, deltaUsd, deltaPct };
  }, [snapshots]);

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
          </span>
        </div>
        <div className={styles.cardStats}>
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

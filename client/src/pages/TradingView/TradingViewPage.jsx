import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts';
import { marketApi } from '../../services/api';
import { useTradingContext } from '../../context/TradingContext';
import { computeSqueezeMomentum, buildSqueezeDots } from './sqzmom';
import styles from './TradingViewPage.module.css';

const TIMEFRAMES = [
  { value: '1m',  label: '1m'  },
  { value: '5m',  label: '5m'  },
  { value: '15m', label: '15m' },
  { value: '1h',  label: '1h'  },
];
const DEFAULT_TIMEFRAME = '15m';
const CANDLE_LIMIT = 500;

// Colores coherentes con el tema dark del resto de la app.
const THEME = {
  background: '#0f1114',
  text: '#b3b8c2',
  grid: 'rgba(120, 130, 145, 0.08)',
  border: 'rgba(120, 130, 145, 0.25)',
  up: '#26a69a',
  down: '#ef5350',
};

export default function TradingViewPage() {
  const { selectedAsset } = useTradingContext();
  const [asset, setAsset] = useState(selectedAsset || 'ETH');
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ lastVal: null, lastSqz: null, candles: 0 });

  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const sqzHistRef = useRef(null);
  const sqzDotsRef = useRef(null);

  // --- 1) Crea el chart una vez y devuelve las refs ---
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: THEME.background },
        textColor: THEME.text,
        panes: { separatorColor: THEME.border, separatorHoverColor: THEME.border },
      },
      grid: {
        vertLines: { color: THEME.grid },
        horzLines: { color: THEME.grid },
      },
      rightPriceScale: { borderColor: THEME.border },
      timeScale: { borderColor: THEME.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    // Pane 0 = precio, pane 1 = SQZMOM (histograma + dots en línea base 0).
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: THEME.up,
      downColor: THEME.down,
      borderUpColor: THEME.up,
      borderDownColor: THEME.down,
      wickUpColor: THEME.up,
      wickDownColor: THEME.down,
    }, 0);
    candleSeriesRef.current = candleSeries;

    const sqzHist = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'SQZMOM',
    }, 1);
    sqzHistRef.current = sqzHist;

    // "Cross" del Pine original: puntos fijos en 0 coloreados por estado
    // del squeeze. Los simulamos con una Line de 1px en el mismo pane.
    const sqzDots = chart.addSeries(LineSeries, {
      color: '#2962ff',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    }, 1);
    sqzDotsRef.current = sqzDots;

    // Stretch factor: precio 70%, SQZMOM 30%.
    try {
      const panes = chart.panes();
      if (panes[0]?.setStretchFactor) panes[0].setStretchFactor(0.7);
      if (panes[1]?.setStretchFactor) panes[1].setStretchFactor(0.3);
    } catch { /* API opcional en algunas versiones */ }

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      sqzHistRef.current = null;
      sqzDotsRef.current = null;
    };
  }, []);

  // --- 2) Carga candles y alimenta las series ---
  const loadData = useCallback(async () => {
    if (!asset) return;
    setLoading(true);
    setError(null);
    try {
      const candles = await marketApi.getCandles({ asset, timeframe, limit: CANDLE_LIMIT });
      if (!Array.isArray(candles) || candles.length === 0) {
        setError('No se recibieron candles del servidor.');
        setLoading(false);
        return;
      }
      const candleData = candles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
      }));
      candleSeriesRef.current?.setData(candleData);

      const sqz = computeSqueezeMomentum(candles);
      const histData = sqz
        .filter((p) => p && p.value != null)
        .map((p) => ({ time: p.time, value: p.value, color: p.color }));
      const dotsData = buildSqueezeDots(sqz.filter((p) => p && p.value != null));
      sqzHistRef.current?.setData(histData);
      sqzDotsRef.current?.setData(dotsData);

      chartRef.current?.timeScale().fitContent();

      const last = sqz[sqz.length - 1];
      setStats({
        candles: candles.length,
        lastVal: last?.value ?? null,
        lastSqz: last ? (last.noSqz ? 'sin squeeze' : last.sqzOn ? 'squeeze ACTIVO' : 'squeeze soltado') : null,
      });
    } catch (err) {
      setError(err.message || 'Error cargando datos de mercado.');
    } finally {
      setLoading(false);
    }
  }, [asset, timeframe]);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.toolGroup}>
          <label>Activo:</label>
          <input
            type="text"
            value={asset}
            onChange={(e) => setAsset(e.target.value.toUpperCase().trim())}
            className={styles.assetInput}
            placeholder="ETH"
            maxLength={10}
          />
        </div>
        <div className={styles.toolGroup}>
          <label>Timeframe:</label>
          <div className={styles.tfGroup}>
            {TIMEFRAMES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`${styles.tfBtn} ${timeframe === t.value ? styles.tfBtnActive : ''}`}
                onClick={() => setTimeframe(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className={styles.refreshBtn} onClick={loadData} disabled={loading}>
          {loading ? '⟳ Cargando…' : '⟳ Refrescar'}
        </button>
        <div className={styles.stats}>
          <span className={styles.statsItem}>
            <span className={styles.statsLabel}>Candles:</span> {stats.candles}
          </span>
          {stats.lastVal != null && (
            <span className={styles.statsItem}>
              <span className={styles.statsLabel}>SQZMOM:</span> {stats.lastVal.toFixed(4)}
            </span>
          )}
          {stats.lastSqz && (
            <span className={styles.statsItem}>
              <span className={styles.statsLabel}>Estado:</span> {stats.lastSqz}
            </span>
          )}
        </div>
      </div>

      <div className={styles.widgetContainer}>
        {error && <div className={styles.error}>{error}</div>}
        <div ref={containerRef} className={styles.chart} />
      </div>
    </div>
  );
}

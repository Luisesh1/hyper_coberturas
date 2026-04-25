import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, CandlestickSeries, CrosshairMode, PriceScaleMode } from 'lightweight-charts';
import { marketApi, settingsApi } from '../../services/api';
import { useTradingContext } from '../../context/TradingContext';
import { createIndicatorsController } from './indicators/renderAdapter';
import { getDefaultChartIndicators } from './indicators/defaults';
import IndicatorConfigModal from './components/IndicatorConfigModal';
import AssetPickerModal from './components/AssetPickerModal';
import DrawingToolbar from './components/DrawingToolbar';
import { useDrawings } from './drawings/use-drawings';
import { TOOLS } from './drawings/catalog';
import styles from './TradingViewPage.module.css';

const ASSET_STORAGE_KEY = 'tv_selected_asset_v1';
const CROSSHAIR_STORAGE_KEY = 'tv_crosshair_mode_v1';
const PRICE_SCALE_STORAGE_KEY = 'tv_price_scale_mode_v1';
const TIMEFRAME_STORAGE_KEY = 'tv_timeframe_v1';
const SETTINGS_VISIBLE_STORAGE_KEY = 'tv_settings_visible_v1';

function loadStoredSettingsVisible() {
  try {
    const raw = localStorage.getItem(SETTINGS_VISIBLE_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    // Default según ancho de viewport: visible en desktop, oculto en mobile.
    return typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 769px)').matches
      : true;
  } catch {
    return true;
  }
}

const PRICE_SCALE_MODES = [
  { value: PriceScaleMode.Normal,      label: 'Regular' },
  { value: PriceScaleMode.Logarithmic, label: 'Logarítmica' },
];
const DEFAULT_PRICE_SCALE_MODE = PriceScaleMode.Normal;

function loadStoredPriceScaleMode() {
  try {
    const raw = localStorage.getItem(PRICE_SCALE_STORAGE_KEY);
    if (raw == null) return DEFAULT_PRICE_SCALE_MODE;
    const n = Number(raw);
    if (PRICE_SCALE_MODES.some((m) => m.value === n)) return n;
    return DEFAULT_PRICE_SCALE_MODE;
  } catch {
    return DEFAULT_PRICE_SCALE_MODE;
  }
}

const CROSSHAIR_MODES = [
  { value: CrosshairMode.Magnet,    label: 'Imán (close)' },
  { value: CrosshairMode.MagnetOHLC, label: 'Imán OHLC' },
  { value: CrosshairMode.Normal,    label: 'Libre' },
  { value: CrosshairMode.Hidden,    label: 'Oculto' },
];
const DEFAULT_CROSSHAIR_MODE = CrosshairMode.Magnet;

function loadStoredCrosshairMode() {
  try {
    const raw = localStorage.getItem(CROSSHAIR_STORAGE_KEY);
    if (raw == null) return DEFAULT_CROSSHAIR_MODE;
    const n = Number(raw);
    if (CROSSHAIR_MODES.some((m) => m.value === n)) return n;
    return DEFAULT_CROSSHAIR_MODE;
  } catch {
    return DEFAULT_CROSSHAIR_MODE;
  }
}

function loadStoredAsset() {
  try {
    const raw = localStorage.getItem(ASSET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.symbol && parsed?.datasource) return parsed;
    return null;
  } catch {
    return null;
  }
}

function storeAsset(asset) {
  try {
    localStorage.setItem(ASSET_STORAGE_KEY, JSON.stringify({
      symbol: asset.symbol, datasource: asset.datasource, name: asset.name,
    }));
  } catch { /* noop */ }
}

const TIMEFRAMES = [
  { value: '1m',  label: '1m'  },
  { value: '5m',  label: '5m'  },
  { value: '15m', label: '15m' },
  { value: '1h',  label: '1h'  },
  { value: '4h',  label: '4h'  },
  { value: '1d',  label: '1D'  },
  { value: '1w',  label: '1W'  },
  { value: '1M',  label: '1M'  },
];
const DEFAULT_TIMEFRAME = '15m';
const CANDLE_LIMIT = 500;

function loadStoredTimeframe() {
  try {
    const raw = localStorage.getItem(TIMEFRAME_STORAGE_KEY);
    if (!raw) return DEFAULT_TIMEFRAME;
    if (TIMEFRAMES.some((t) => t.value === raw)) return raw;
    return DEFAULT_TIMEFRAME;
  } catch {
    return DEFAULT_TIMEFRAME;
  }
}

// Duración de un bar en segundos por timeframe (1M aproximado a 30d).
const TIMEFRAME_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': 604_800,
  '1M': 2_592_000,
};

function formatProjectedTime(sec, tf) {
  const d = new Date(sec * 1000);
  const daily = tf === '1d' || tf === '1w' || tf === '1M';
  if (daily) {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  }
  return d.toLocaleString(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Intervalo de polling en tiempo real por timeframe.
// Compromiso entre frescura y carga de red (el backend cachea 10s).
const LIVE_POLL_MS = {
  '1m':  3_000,
  '5m':  5_000,
  '15m': 8_000,
  '1h':  15_000,
  '4h':  30_000,
  '1d':  60_000,
  '1w':  300_000,
  '1M':  600_000,
};

const THEME = {
  background: '#0f1114',
  text: '#b3b8c2',
  grid: 'rgba(120, 130, 145, 0.08)',
  border: 'rgba(120, 130, 145, 0.25)',
  up: '#26a69a',
  down: '#ef5350',
};

export default function TradingViewPage() {
  const { selectedAsset, addNotification } = useTradingContext();
  const [asset, setAsset] = useState(() => {
    return loadStoredAsset() || {
      symbol: selectedAsset || 'ETH',
      datasource: 'hyperliquid',
      name: selectedAsset || 'ETH',
    };
  });
  const [timeframe, setTimeframe] = useState(loadStoredTimeframe);
  const [crosshairMode, setCrosshairMode] = useState(loadStoredCrosshairMode);
  const [priceScaleMode, setPriceScaleMode] = useState(loadStoredPriceScaleMode);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [candleCount, setCandleCount] = useState(0);

  const [indicators, setIndicators] = useState(() => getDefaultChartIndicators().indicators);
  const [modalOpen, setModalOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [lastPrice, setLastPrice] = useState(null);
  const [liveActive, setLiveActive] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [activeTool, setActiveTool] = useState(null);
  const [futureTimeLabel, setFutureTimeLabel] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(loadStoredSettingsVisible);

  const pageRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const candlesRef = useRef([]);
  const indicatorsControllerRef = useRef(null);
  const indicatorsRef = useRef(indicators);
  const liveTimerRef = useRef(null);
  const fetchingHistoryRef = useRef(false);
  const reachedHistoryEndRef = useRef(false);
  const assetKeyRef = useRef('');
  const drawingsCanvasRef = useRef(null);
  const widgetContainerRef = useRef(null);

  // Mantener ref al día para efectos que leen indicadores sin re-crear.
  useEffect(() => { indicatorsRef.current = indicators; }, [indicators]);

  // --- 1) Carga preferencias del usuario al mount ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await settingsApi.getChartIndicators();
        if (cancelled) return;
        const list = Array.isArray(res?.indicators) ? res.indicators : [];
        if (list.length > 0) setIndicators(list);
      } catch (err) {
        // si falla, queda el default (SQZMOM)
        if (!cancelled) addNotification?.('alert', `No se pudo cargar tu config de indicadores: ${err.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [addNotification]);

  // --- 2) Crea el chart una vez ---
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
      rightPriceScale: { borderColor: THEME.border, mode: priceScaleMode },
      timeScale: {
        borderColor: THEME.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
      },
      crosshair: { mode: crosshairMode },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: THEME.up,
      downColor: THEME.down,
      borderUpColor: THEME.up,
      borderDownColor: THEME.down,
      wickUpColor: THEME.up,
      wickDownColor: THEME.down,
    }, 0);
    candleSeriesRef.current = candleSeries;

    indicatorsControllerRef.current = createIndicatorsController(chart);

    return () => {
      indicatorsControllerRef.current?.removeAll();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      indicatorsControllerRef.current = null;
    };
  }, []);

  // Proyecta tiempo al futuro cuando el crosshair está más allá de la última vela.
  // lightweight-charts no emite `param.time` en el área vacía a la derecha;
  // usamos `param.logical` + la última vela + duración del timeframe para
  // calcular el tiempo proyectado y pintamos una etiqueta flotante propia.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return undefined;
    const handler = (param) => {
      if (!param?.point || candlesRef.current.length === 0) {
        setFutureTimeLabel(null);
        return;
      }
      // Si el chart ya conoce un `time` real (hay vela ahí), lo maneja nativamente.
      if (param.time != null || param.logical == null) {
        setFutureTimeLabel(null);
        return;
      }
      const candles = candlesRef.current;
      const lastIdx = candles.length - 1;
      const lastSec = Math.floor(candles[lastIdx].time / 1000);
      const tfSec = TIMEFRAME_SECONDS[timeframe] || 60;
      const delta = param.logical - lastIdx;
      if (delta <= 0) { setFutureTimeLabel(null); return; }
      const projectedSec = lastSec + delta * tfSec;
      setFutureTimeLabel({ x: param.point.x, text: formatProjectedTime(projectedSec, timeframe) });
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [timeframe]);

  // Aplica el modo del crosshair en vivo + persiste la preferencia.
  useEffect(() => {
    chartRef.current?.applyOptions({ crosshair: { mode: crosshairMode } });
    try { localStorage.setItem(CROSSHAIR_STORAGE_KEY, String(crosshairMode)); } catch { /* noop */ }
  }, [crosshairMode]);

  // Persiste la última temporalidad usada.
  useEffect(() => {
    try { localStorage.setItem(TIMEFRAME_STORAGE_KEY, timeframe); } catch { /* noop */ }
  }, [timeframe]);

  // Aplica el modo de escala de precio (regular/log) SÓLO al pane 0 (precio).
  // Los sub-panes de osciladores fuerzan su propia escala Normal al crearse
  // (ver renderAdapter.js), por lo que no deben verse afectados aquí.
  useEffect(() => {
    try { chartRef.current?.priceScale('right', 0).applyOptions({ mode: priceScaleMode }); } catch { /* noop */ }
    try { localStorage.setItem(PRICE_SCALE_STORAGE_KEY, String(priceScaleMode)); } catch { /* noop */ }
  }, [priceScaleMode]);

  // Pantalla completa: intenta la Fullscreen API nativa (desktop/Android) y
  // cae a "pseudo-fullscreen" vía CSS (iOS Safari, que no soporta la API en divs).
  const toggleFullscreen = useCallback(() => {
    const next = !fullscreen;
    setFullscreen(next);
    try {
      if (next) {
        const el = pageRef.current;
        if (el?.requestFullscreen) el.requestFullscreen().catch(() => { /* noop */ });
      } else if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => { /* noop */ });
      }
    } catch { /* noop */ }
  }, [fullscreen]);

  // Sincroniza cuando el usuario sale de fullscreen con Esc o con el botón del navegador.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // En iOS (o cuando la API nativa no disparó), Esc también debe cerrar el pseudo-fullscreen.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // Marca <body> con una clase mientras estamos en fullscreen para que el
  // header global (App) pueda ocultarse en mobile y aprovechar todo el alto.
  useEffect(() => {
    if (!fullscreen) return undefined;
    document.body.classList.add('tv-fullscreen-active');
    return () => document.body.classList.remove('tv-fullscreen-active');
  }, [fullscreen]);

  // Persiste la preferencia de visibilidad de los ajustes secundarios.
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_VISIBLE_STORAGE_KEY, settingsVisible ? '1' : '0'); } catch { /* noop */ }
  }, [settingsVisible]);

  // --- 3) Carga candles ---
  const loadData = useCallback(async () => {
    if (!asset?.symbol) return;
    setLoading(true);
    setError(null);
    // Al cambiar de par o timeframe reseteamos el estado de paginación.
    assetKeyRef.current = `${asset.datasource}:${asset.symbol}:${timeframe}`;
    reachedHistoryEndRef.current = false;
    fetchingHistoryRef.current = false;
    try {
      const candles = await marketApi.getCandles({
        asset: asset.symbol,
        datasource: asset.datasource || 'hyperliquid',
        timeframe,
        limit: CANDLE_LIMIT,
      });
      if (!Array.isArray(candles) || candles.length === 0) {
        setError('No se recibieron candles del servidor.');
        setLoading(false);
        return;
      }
      candlesRef.current = candles;
      const candleData = candles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
      }));
      candleSeriesRef.current?.setData(candleData);

      indicatorsControllerRef.current?.render(indicatorsRef.current, candles);

      chartRef.current?.timeScale().fitContent();
      setCandleCount(candles.length);
      setLastPrice(candles[candles.length - 1]?.close ?? null);
    } catch (err) {
      console.error('[TradingView] loadData error:', err);
      setError(err.message || 'Error cargando datos de mercado.');
    } finally {
      setLoading(false);
    }
  }, [asset, timeframe]);

  useEffect(() => { loadData(); }, [loadData]);

  // --- 4) Polling en tiempo real del último candle ---
  useEffect(() => {
    if (liveTimerRef.current) {
      clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    setLiveActive(false);

    const intervalMs = LIVE_POLL_MS[timeframe] || 15_000;
    let cancelled = false;

    async function tick() {
      if (cancelled || document.hidden) return;
      try {
        const recent = await marketApi.getCandles({
          asset: asset.symbol,
          datasource: asset.datasource || 'hyperliquid',
          timeframe,
          limit: 3,
        });
        if (cancelled || !Array.isArray(recent) || recent.length === 0) return;
        const current = candlesRef.current;
        if (current.length === 0) return;

        const latest = recent[recent.length - 1];
        const lastExisting = current[current.length - 1];

        if (latest.time === lastExisting.time) {
          // Mismo candle → actualiza en sitio (evita re-flow completo).
          current[current.length - 1] = { ...lastExisting, ...latest };
        } else if (latest.time > lastExisting.time) {
          // Nuevo candle → push + mantén el tope del array
          current.push(latest);
          if (current.length > CANDLE_LIMIT) current.shift();
        } else {
          return;
        }

        candleSeriesRef.current?.update({
          time: Math.floor(latest.time / 1000),
          open: latest.open, high: latest.high, low: latest.low, close: latest.close,
        });

        // Re-render indicadores (ligero: mismo dataset, último valor actualizado)
        indicatorsControllerRef.current?.render(indicatorsRef.current, current);
        setLastPrice(latest.close);
        setLiveActive(true);
      } catch (err) {
        console.warn('[TradingView] live poll error:', err.message);
      }
    }

    // Primer tick corto tras la carga inicial
    const firstId = setTimeout(tick, Math.min(intervalMs, 3_000));
    liveTimerRef.current = setInterval(tick, intervalMs);

    return () => {
      cancelled = true;
      clearTimeout(firstId);
      if (liveTimerRef.current) {
        clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, [asset, timeframe]);

  // --- 5) Re-render cuando cambian los indicadores (sin recargar candles) ---
  useEffect(() => {
    if (!indicatorsControllerRef.current || candlesRef.current.length === 0) return;
    indicatorsControllerRef.current.render(indicators, candlesRef.current);
  }, [indicators]);

  // --- 6) Scroll infinito: carga histórico cuando el usuario llega al borde izquierdo ---
  const fetchMoreHistory = useCallback(async () => {
    if (fetchingHistoryRef.current || reachedHistoryEndRef.current) return;
    const current = candlesRef.current;
    if (current.length === 0) return;
    const snapshotKey = `${asset.datasource}:${asset.symbol}:${timeframe}`;
    // Si el usuario cambió de par/TF mientras esto corría, abortar.
    if (snapshotKey !== assetKeyRef.current) return;

    fetchingHistoryRef.current = true;
    setLoadingHistory(true);
    try {
      const oldestTime = current[0].time;
      const older = await marketApi.getCandles({
        asset: asset.symbol,
        datasource: asset.datasource || 'hyperliquid',
        timeframe,
        limit: 500,
        endTime: oldestTime - 1,
      });
      if (snapshotKey !== assetKeyRef.current) return;
      if (!Array.isArray(older) || older.length === 0) {
        reachedHistoryEndRef.current = true;
        return;
      }
      const seen = new Set(current.map((c) => c.time));
      const newBars = older.filter((c) => !seen.has(c.time));
      if (newBars.length === 0) {
        reachedHistoryEndRef.current = true;
        return;
      }
      const merged = [...newBars, ...current].sort((a, b) => a.time - b.time);
      candlesRef.current = merged;
      const candleData = merged.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
      }));

      // Preserva la ventana visible para evitar "salto" tras el setData.
      const prevRange = chartRef.current?.timeScale().getVisibleRange();
      candleSeriesRef.current?.setData(candleData);
      if (prevRange) chartRef.current?.timeScale().setVisibleRange(prevRange);

      indicatorsControllerRef.current?.render(indicatorsRef.current, merged);
      setCandleCount(merged.length);
    } catch (err) {
      console.warn('[TradingView] fetchMoreHistory error:', err.message);
    } finally {
      fetchingHistoryRef.current = false;
      setLoadingHistory(false);
    }
  }, [asset, timeframe]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return undefined;
    const timeScale = chart.timeScale();
    const onRange = (range) => {
      if (!range || candlesRef.current.length === 0) return;
      // `range.from` es el índice lógico del primer bar visible.
      // Cuando se acerca a 0 (o se vuelve negativo) el usuario está
      // pidiendo más historia hacia atrás.
      if (range.from < 10) {
        fetchMoreHistory();
      }
    };
    timeScale.subscribeVisibleLogicalRangeChange(onRange);
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(onRange);
  }, [fetchMoreHistory]);

  // --- 5) Guardar config ---
  const handleSaveIndicators = useCallback(async (next) => {
    try {
      const res = await settingsApi.saveChartIndicators({ indicators: next });
      const saved = Array.isArray(res?.indicators) ? res.indicators : next;
      setIndicators(saved);
      setModalOpen(false);
      addNotification?.('success', 'Configuración de indicadores guardada');
    } catch (err) {
      addNotification?.('error', `No se pudo guardar: ${err.message}`);
    }
  }, [addNotification]);

  const handleSelectAsset = useCallback((next) => {
    setAsset({ symbol: next.symbol, datasource: next.datasource, name: next.name });
    storeAsset(next);
    setAssetPickerOpen(false);
  }, []);

  // --- Drawings overlay ---
  const drawings = useDrawings({
    chartRef,
    seriesRef: candleSeriesRef,
    candlesRef,
    containerRef: widgetContainerRef,
    canvasRef: drawingsCanvasRef,
    symbol: asset.symbol,
    timeframe,
    activeTool,
    setActiveTool,
    onNotify: addNotification,
  });

  // La cursor y el pointer-events del canvas dependen del estado de la herramienta.
  const canvasInteractive = activeTool !== null && activeTool !== 'select';
  const canvasCursor = activeTool && TOOLS[activeTool] ? TOOLS[activeTool].cursor : 'default';

  const visibleIndicatorsCount = indicators.filter((i) => i.visible !== false).length;

  // Helpers reutilizables: los mismos controles se renderizan en la barra
  // superior (desktop) y en la inferior (mobile). Son stateless/sin IDs
  // propios, así que duplicarlos en el árbol no introduce conflictos.
  const renderTimeframes = (extraClass = '') => (
    <div className={`${styles.tfGroup} ${extraClass}`}>
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
  );

  const renderActionButtons = () => (
    <>
      <button
        type="button"
        className={styles.refreshBtn}
        onClick={loadData}
        disabled={loading}
        title="Refrescar datos"
        aria-label="Refrescar"
      >
        <span className={styles.btnIcon}>⟳</span>
        <span className={styles.btnText}>{loading ? 'Cargando…' : 'Refrescar'}</span>
      </button>
      <button
        type="button"
        className={styles.refreshBtn}
        onClick={() => setModalOpen(true)}
        title="Configurar indicadores"
        aria-label="Indicadores"
      >
        <span className={styles.btnIcon}>⚙️</span>
        <span className={styles.btnText}>Indicadores ({visibleIndicatorsCount})</span>
        <span className={styles.btnBadge} aria-hidden="true">{visibleIndicatorsCount}</span>
      </button>
      <button
        type="button"
        className={`${styles.refreshBtn} ${styles.settingsBtn}`}
        onClick={() => setSettingsVisible((v) => !v)}
        title={settingsVisible ? 'Ocultar ajustes (crosshair, escala)' : 'Mostrar ajustes (crosshair, escala)'}
        aria-label={settingsVisible ? 'Ocultar ajustes' : 'Mostrar ajustes'}
        aria-pressed={settingsVisible}
      >
        <svg className={styles.fsIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="2.25" />
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
        </svg>
      </button>
      <button
        type="button"
        className={`${styles.refreshBtn} ${styles.fullscreenBtn}`}
        onClick={toggleFullscreen}
        title={fullscreen ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}
        aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
        aria-pressed={fullscreen}
      >
        {fullscreen ? (
          <svg className={styles.fsIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
          </svg>
        ) : (
          <svg className={styles.fsIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
          </svg>
        )}
      </button>
    </>
  );

  // Los selects con id= (crosshair-mode, price-scale-mode) se renderizan una
  // sola vez para evitar ids duplicados en el DOM. Aparecen inline en desktop
  // y como fila adicional en mobile cuando el usuario activa los ajustes.
  const secondaryControlsNode = (
    <>
      <div className={`${styles.toolGroup} ${styles.toolGroupSecondary}`}>
        <label htmlFor="crosshair-mode">Crosshair:</label>
        <select
          id="crosshair-mode"
          className={styles.select}
          value={crosshairMode}
          onChange={(e) => setCrosshairMode(Number(e.target.value))}
          title="Modo del crosshair"
        >
          {CROSSHAIR_MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>
      <div className={`${styles.toolGroup} ${styles.toolGroupSecondary}`}>
        <label htmlFor="price-scale-mode">Escala:</label>
        <select
          id="price-scale-mode"
          className={styles.select}
          value={priceScaleMode}
          onChange={(e) => setPriceScaleMode(Number(e.target.value))}
          title="Escala de precio"
        >
          {PRICE_SCALE_MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>
    </>
  );

  const statsNode = (
    <div className={styles.stats}>
      {lastPrice != null && (
        <span className={styles.statsItem}>
          <span className={liveActive ? styles.liveDot : styles.liveDotIdle} />
          <span className={styles.statsLabel}>{liveActive ? 'En vivo' : 'Último'}:</span>
          <span className={styles.lastPrice}>
            ${Number(lastPrice).toLocaleString('en-US', { maximumFractionDigits: 6 })}
          </span>
        </span>
      )}
      <span className={`${styles.statsItem} ${styles.statsItemSecondary}`}>
        <span className={styles.statsLabel}>Candles:</span> {candleCount}
        {loadingHistory && <span className={styles.histSpinner}>↻</span>}
        {reachedHistoryEndRef.current && <span className={styles.histEnd} title="No hay más historia">·</span>}
      </span>
    </div>
  );

  return (
    <div
      ref={pageRef}
      className={`${styles.page} ${fullscreen ? styles.pageFullscreen : ''} ${settingsVisible ? styles.settingsVisible : styles.settingsHidden}`}
    >
      <div className={styles.toolbar}>
        {/* Siempre visible: asset + precio. En mobile es la única fila del top. */}
        <div className={styles.toolbarMain}>
          <div className={styles.toolGroup}>
            <label>Par:</label>
            <button
              type="button"
              className={styles.assetButton}
              onClick={() => setAssetPickerOpen(true)}
              title={asset.name || asset.symbol}
            >
              <span className={styles.assetButtonSymbol}>{asset.symbol}</span>
              <span className={styles.assetButtonSource}>{asset.datasource}</span>
              <span className={styles.assetButtonCaret}>▾</span>
            </button>
          </div>
          {statsNode}
        </div>

        {/* Crosshair + escala: inline en desktop; en mobile, nueva fila
            colapsable controlada por el toggle de ajustes. */}
        <div className={styles.toolbarSecondary}>
          {secondaryControlsNode}
        </div>

        {/* Timeframes + botones de acción: en desktop quedan inline arriba;
            en mobile se ocultan y aparecen duplicados en la barra inferior. */}
        <div className={styles.toolbarDesktop}>
          <div className={styles.toolGroup}>
            <label>Timeframe:</label>
            {renderTimeframes()}
          </div>
          {renderActionButtons()}
        </div>
      </div>

      <div ref={widgetContainerRef} className={styles.widgetContainer}>
        {error && <div className={styles.error}>{error}</div>}
        <div ref={containerRef} className={styles.chart} />

        <canvas
          ref={drawingsCanvasRef}
          className={styles.drawingsCanvas}
          style={{
            pointerEvents: canvasInteractive || drawings.selectedUid ? 'auto' : (activeTool === 'select' ? 'auto' : 'none'),
            cursor: canvasCursor,
          }}
          onMouseDown={drawings.onMouseDown}
          onMouseMove={drawings.onMouseMove}
          onMouseUp={drawings.onMouseUp}
        />

        <DrawingToolbar
          activeTool={activeTool}
          onSelectTool={setActiveTool}
          onClear={drawings.clearAll}
          selectedUid={drawings.selectedUid}
          onDeleteSelected={drawings.deleteSelected}
          hasDrawings={drawings.drawings.length > 0}
        />

        {futureTimeLabel && (
          <div
            className={styles.futureTimeLabel}
            style={{ left: `${futureTimeLabel.x}px` }}
          >
            {futureTimeLabel.text}
          </div>
        )}
      </div>

      {/* Barra inferior: sólo visible en mobile. Contiene los timeframes
          (scroll horizontal) y los botones de acción, al estilo de la app
          de TradingView en móvil. */}
      <div className={styles.bottomBar}>
        <div className={styles.bottomBarTf}>
          {renderTimeframes(styles.tfGroupMobile)}
        </div>
        <div className={styles.bottomBarActions}>
          {renderActionButtons()}
        </div>
      </div>

      <IndicatorConfigModal
        open={modalOpen}
        initialIndicators={indicators}
        onSave={handleSaveIndicators}
        onCancel={() => setModalOpen(false)}
      />

      <AssetPickerModal
        open={assetPickerOpen}
        currentAsset={asset}
        onSelect={handleSelectAsset}
        onCancel={() => setAssetPickerOpen(false)}
      />
    </div>
  );
}

import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createChart, CandlestickSeries, CrosshairMode, PriceScaleMode } from 'lightweight-charts';
import { marketApi, settingsApi } from '../../services/api';
import { useTradingContext } from '../../context/TradingContext';
import { createIndicatorsController } from './indicators/renderAdapter';
import { getDefaultChartIndicators } from './indicators/defaults';
import IndicatorConfigModal from './components/IndicatorConfigModal';
import AssetPickerModal from './components/AssetPickerModal';
import DrawingToolbar from './components/DrawingToolbar';
import ReplayPanel from './components/ReplayPanel';
import MobileTabBar from './components/MobileTabBar';
import MobileDrawingBar, { MobileDrawingBanner } from './components/MobileDrawingBar';
import MobileSettingsSheet from './components/MobileSettingsSheet';
import {
  ChevronDownIcon, CollapseIcon, ExpandIcon, EyeIcon, EyeOffIcon,
  IndicatorsIcon, MoreIcon, RefreshIcon, ReplayIcon, SlidersIcon, StarIcon,
} from './components/icons';
import BottomSheet from './components/BottomSheet';
import mobileStyles from './components/MobileChrome.module.css';
import { computePriceChange } from './priceChange';
import { loadFavorites, rowItems, saveFavorites, toggleFavorite } from './timeframeFavorites';
import { formatIndicatorLabel } from './indicators/formatLabel';
import { MOBILE_QUERY, useMediaQuery } from './useMediaQuery';
import { useReplayController } from './replay/useReplayController';
import { useDrawings } from './drawings/use-drawings';
import { TOOLS } from './drawings/catalog';
import { getInitialChartViewport } from './chartViewport';
import styles from './TradingViewPage.module.css';

const ASSET_STORAGE_KEY = 'tv_selected_asset_v1';
const CROSSHAIR_STORAGE_KEY = 'tv_crosshair_mode_v1';
const PRICE_SCALE_STORAGE_KEY = 'tv_price_scale_mode_v1';
const TIMEFRAME_STORAGE_KEY = 'tv_timeframe_v1';
const SETTINGS_VISIBLE_STORAGE_KEY = 'tv_settings_visible_v1';
const OVERLAYS_HIDDEN_STORAGE_KEY = 'tv_overlays_hidden_v1';

function loadStoredOverlaysHidden() {
  try {
    return localStorage.getItem(OVERLAYS_HIDDEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

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
  { value: PriceScaleMode.Normal,      label: 'Regular',     short: 'Regular' },
  { value: PriceScaleMode.Logarithmic, label: 'Logarítmica', short: 'Log' },
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
  { value: CrosshairMode.Magnet,     label: 'Imán (close)', short: 'Imán' },
  { value: CrosshairMode.MagnetOHLC, label: 'Imán OHLC',    short: 'OHLC' },
  { value: CrosshairMode.Normal,     label: 'Libre',        short: 'Libre' },
  { value: CrosshairMode.Hidden,     label: 'Oculto',       short: 'Oculto' },
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
const TIMEFRAME_VALUES = TIMEFRAMES.map((t) => t.value);
const DEFAULT_TIMEFRAME = '15m';
const CANDLE_LIMIT = 500;
const DEFAULT_RIGHT_OFFSET = 12;
const DEFAULT_PRICE_PRECISION = 2;

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

// Formatea un precio con decimales adaptativos al orden de magnitud.
// 70,510.73 (BTC) | 2,348.7 (ETH) | 145.62 | 0.85432 | 0.0000123
function getPricePrecisionFromValue(value) {
  const abs = Math.abs(Number(value));
  if (!Number.isFinite(abs) || abs === 0) return DEFAULT_PRICE_PRECISION;
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  return 8;
}

function getPricePrecisionFromCandles(candles = []) {
  const minPrice = candles.reduce((min, candle) => {
    const values = [candle?.open, candle?.high, candle?.low, candle?.close]
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (values.length === 0) return min;
    return Math.min(min, ...values);
  }, Infinity);
  return Number.isFinite(minPrice) ? getPricePrecisionFromValue(minPrice) : DEFAULT_PRICE_PRECISION;
}

function getPriceFormatOptions(precision) {
  return {
    type: 'price',
    precision,
    minMove: precision > 0 ? 10 ** -precision : 1,
  };
}

function formatPrice(n, precision = getPricePrecisionFromValue(n)) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision >= 4 ? 0 : precision,
  });
}

function formatChange(n, precision) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatPrice(n, precision)}`;
}

function formatPercent(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
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
  upEdge: '#39c8b9',
  downEdge: '#ff6b68',
};

export default function TradingViewPage() {
  const { selectedAsset, addNotification } = useTradingContext();
  const [searchParams] = useSearchParams();
  const urlSymbol = searchParams.get('symbol');
  const urlTf = searchParams.get('tf');
  const urlDatasource = searchParams.get('datasource');
  const [asset, setAsset] = useState(() => {
    if (urlSymbol) {
      return {
        symbol: urlSymbol,
        datasource: urlDatasource || 'binance',
        name: urlSymbol,
      };
    }
    return loadStoredAsset() || {
      symbol: selectedAsset || 'ETH',
      datasource: 'hyperliquid',
      name: selectedAsset || 'ETH',
    };
  });
  const [timeframe, setTimeframe] = useState(() => {
    if (urlTf && TIMEFRAMES.some((t) => t.value === urlTf)) return urlTf;
    return loadStoredTimeframe();
  });

  // Reaccionar a cambios del query (back/forward del navegador o navegación
  // entre alertas distintas sin remount). No limpiamos los params para que
  // la URL quede compartible y refresh-safe.
  useEffect(() => {
    if (urlSymbol) {
      setAsset((prev) => prev.symbol === urlSymbol && prev.datasource === (urlDatasource || prev.datasource)
        ? prev
        : { symbol: urlSymbol, datasource: urlDatasource || 'binance', name: urlSymbol });
    }
    if (urlTf && TIMEFRAMES.some((t) => t.value === urlTf)) setTimeframe(urlTf);
  }, [urlSymbol, urlTf, urlDatasource]);
  const [crosshairMode, setCrosshairMode] = useState(loadStoredCrosshairMode);
  const [priceScaleMode, setPriceScaleMode] = useState(loadStoredPriceScaleMode);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [candleCount, setCandleCount] = useState(0);

  const [indicators, setIndicators] = useState(() => getDefaultChartIndicators().indicators);
  const [modalOpen, setModalOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [lastPrice, setLastPrice] = useState(null);
  const [pricePrecision, setPricePrecision] = useState(DEFAULT_PRICE_PRECISION);
  const [liveActive, setLiveActive] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [activeTool, setActiveTool] = useState(null);
  const [futureTimeLabel, setFutureTimeLabel] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(loadStoredSettingsVisible);
  const [replayPanelOpen, setReplayPanelOpen] = useState(false);
  const [hoveredOhlc, setHoveredOhlc] = useState(null);
  const [overlaysHidden, setOverlaysHidden] = useState(loadStoredOverlaysHidden);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // Móvil: modo dibujo explícito (la barra de pestañas pasa a ser la de
  // herramientas), hoja de ajustes y leyenda OHLC plegable.
  const [drawMode, setDrawMode] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);
  const [ohlcExpanded, setOhlcExpanded] = useState(false);
  // Móvil: la fila de temporalidades sólo muestra las favoritas; el resto
  // (y la edición de favoritas) vive en una hoja inferior.
  const [tfFavorites, setTfFavorites] = useState(() => loadFavorites(TIMEFRAME_VALUES));
  const [tfSheetOpen, setTfSheetOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(OVERLAYS_HIDDEN_STORAGE_KEY, overlaysHidden ? '1' : '0'); } catch { /* noop */ }
  }, [overlaysHidden]);

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
        rightOffset: DEFAULT_RIGHT_OFFSET,
      },
      crosshair: { mode: crosshairMode },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: THEME.up,
      downColor: THEME.down,
      borderUpColor: THEME.upEdge,
      borderDownColor: THEME.downEdge,
      wickUpColor: THEME.upEdge,
      wickDownColor: THEME.downEdge,
      priceFormat: getPriceFormatOptions(DEFAULT_PRICE_PRECISION),
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
  // El mismo handler también alimenta el overlay OHLC superior derecho:
  // cuando hay `param.time` (cursor sobre una vela real) buscamos la vela
  // correspondiente en candlesRef y la exponemos por estado.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return undefined;
    const handler = (param) => {
      // --- Overlay OHLC: vela bajo el cursor ---
      if (param?.time != null && candlesRef.current.length > 0) {
        const tMs = typeof param.time === 'number' ? param.time * 1000 : null;
        if (tMs != null) {
          const c = candlesRef.current.find((x) => x.time === tMs);
          setHoveredOhlc(c || null);
        }
      } else {
        // Cursor fuera del área de velas o en zona vacía → mostrar la última.
        setHoveredOhlc(null);
      }

      // --- Etiqueta de tiempo futuro (zona derecha sin velas) ---
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

  useEffect(() => { saveFavorites(tfFavorites); }, [tfFavorites]);

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
      const nextPrecision = getPricePrecisionFromCandles(candles);
      candleSeriesRef.current?.applyOptions({ priceFormat: getPriceFormatOptions(nextPrecision) });
      setPricePrecision(nextPrecision);
      const candleData = candles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
      }));
      candleSeriesRef.current?.setData(candleData);

      indicatorsControllerRef.current?.render(indicatorsRef.current, candles);

      // El encuadre inicial se adapta al ancho real: menos velas en móvil y
      // más contexto en escritorio, sin comprimir las 500 velas cargadas.
      const { rightOffset, barSpacing } = getInitialChartViewport(
        containerRef.current?.clientWidth,
        candleData.length,
      );
      chartRef.current?.timeScale().applyOptions({ barSpacing, rightOffset });
      chartRef.current?.timeScale().scrollToRealTime();
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

  // --- Replay mode controller ---
  // Vive entre loadData y el polling live: cuando está activo, este último
  // se suspende (ver dependencia `replayActive` en el efecto siguiente).
  const replay = useReplayController({
    asset,
    timeframe,
    candleSeriesRef,
    candlesRef,
    indicatorsControllerRef,
    indicatorsRef,
    chartRef,
    onError: (msg) => addNotification?.('error', msg),
    // Durante replay el polling live se suspende. Al salir recargamos el
    // dataset completo para incluir todas las velas nacidas durante la sesión,
    // no solo la última que recuperaría el siguiente tick.
    onStopped: () => { void loadData(); },
    // Cada tick del replay actualiza lastPrice para forzar un re-render
    // del overlay OHLC (que lee la última vela in-progress).
    onTick: (htf) => setLastPrice(htf.close),
  });
  const replayActive = replay.active;

  // --- 4) Polling en tiempo real del último candle ---
  // Si el modo replay está activo, suspendemos el polling para no pisar la
  // vela HTF en formación con datos vivos.
  useEffect(() => {
    if (liveTimerRef.current) {
      clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    setLiveActive(false);

    if (replayActive) return undefined;

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

        const nextPrecision = getPricePrecisionFromCandles(current);
        if (nextPrecision !== pricePrecision) {
          candleSeriesRef.current?.applyOptions({ priceFormat: getPriceFormatOptions(nextPrecision) });
          setPricePrecision(nextPrecision);
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
  }, [asset, timeframe, replayActive, pricePrecision]);

  // --- 5) Re-render cuando cambian los indicadores (sin recargar candles) ---
  useEffect(() => {
    if (!indicatorsControllerRef.current || candlesRef.current.length === 0) return;
    indicatorsControllerRef.current.render(indicators, candlesRef.current);
  }, [indicators]);

  // --- 6) Scroll infinito: carga histórico cuando el usuario llega al borde izquierdo ---
  // Suspendido durante replay: el array candlesRef se está mutando por el hook
  // de replay y agregar barras aquí corrompería su snapshot.
  const fetchMoreHistory = useCallback(async () => {
    if (replayActive) return;
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
      const nextPrecision = getPricePrecisionFromCandles(merged);
      candleSeriesRef.current?.applyOptions({ priceFormat: getPriceFormatOptions(nextPrecision) });
      setPricePrecision(nextPrecision);
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
  }, [asset, timeframe, replayActive]);

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

  const exitDrawMode = useCallback(() => {
    setActiveTool(null);
    setDrawMode(false);
  }, []);

  // El modo dibujo es sólo móvil: al pasar a escritorio se descarta.
  useEffect(() => {
    if (!isMobile) setDrawMode(false);
  }, [isMobile]);

  // Marca <body> mientras la UI móvil ocupa el borde inferior, para que
  // elementos flotantes globales (p. ej. el panel de logs de dev) se aparten.
  useEffect(() => {
    if (!isMobile) return undefined;
    document.body.classList.add('tv-mobile-chrome');
    return () => document.body.classList.remove('tv-mobile-chrome');
  }, [isMobile]);

  // La cursor y el pointer-events del canvas dependen del estado de la herramienta.
  const canvasInteractive = activeTool !== null && activeTool !== 'select';
  const canvasCursor = activeTool && TOOLS[activeTool] ? TOOLS[activeTool].cursor : 'default';

  const visibleIndicatorsCount = indicators.filter((i) => i.visible !== false).length;

  // Vela a mostrar en el overlay OHLC: la que está bajo el crosshair, o la
  // última disponible si el cursor está fuera. Lee candlesRef directamente
  // (mutado in-place por live polling y replay). Los re-renders los
  // disparan setLastPrice (polling+tick replay) y setHoveredOhlc (crosshair).
  const lastCandleIdx = candlesRef.current.length - 1;
  const lastCandle = lastCandleIdx >= 0 ? candlesRef.current[lastCandleIdx] : null;
  const displayedOhlc = hoveredOhlc || lastCandle;
  // Vela previa (para change inter-bar): recalculada cada render.
  let prevCandle = null;
  if (displayedOhlc) {
    const idx = candlesRef.current.findIndex((c) => c.time === displayedOhlc.time);
    if (idx > 0) prevCandle = candlesRef.current[idx - 1];
  }

  // Legend de indicadores: valores en el timestamp mostrado. Vacío si no
  // hay vela o controlador. lightweight-charts usa segundos.
  const indicatorLegend = (displayedOhlc && indicatorsControllerRef.current?.getValuesAt)
    ? indicatorsControllerRef.current.getValuesAt(Math.floor(displayedOhlc.time / 1000))
    : [];

  // Datos de la vela mostrada (cambio intra-vela y respecto a la anterior),
  // compartidos por el overlay de escritorio y la leyenda compacta móvil.
  let ohlcInfo = null;
  if (displayedOhlc) {
    const intra = displayedOhlc.close - displayedOhlc.open;
    const inter = prevCandle ? displayedOhlc.close - prevCandle.close : null;
    ohlcInfo = {
      intra,
      intraPct: displayedOhlc.open ? (intra / displayedOhlc.open) * 100 : null,
      inter,
      interPct: prevCandle?.close ? (inter / prevCandle.close) * 100 : null,
      upBar: displayedOhlc.close >= displayedOhlc.open,
    };
  }

  const ohlcValues = displayedOhlc ? [
    ['O', displayedOhlc.open],
    ['H', displayedOhlc.high],
    ['L', displayedOhlc.low],
    ['C', displayedOhlc.close],
  ] : [];

  const timeframeButtons = (btnClass, activeClass, items = TIMEFRAMES) => items.map((t) => (
    <button
      key={t.value}
      type="button"
      className={`${btnClass} ${timeframe === t.value ? activeClass : ''}`}
      onClick={() => setTimeframe(t.value)}
      aria-pressed={timeframe === t.value}
    >
      {t.label}
    </button>
  ));

  // Barra superior de escritorio: par, precio, temporalidades, acciones y
  // (opcionalmente) crosshair + escala.
  const desktopToolbar = (
    <div className={styles.toolbar}>
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
        <div className={styles.stats}>
          {lastPrice != null && (
            <span className={styles.statsItem}>
              <span className={liveActive ? styles.liveDot : styles.liveDotIdle} />
              <span className={styles.statsLabel}>{liveActive ? 'En vivo' : 'Último'}:</span>
              <span className={styles.lastPrice}>
                ${formatPrice(Number(lastPrice), pricePrecision)}
              </span>
            </span>
          )}
          <span className={styles.statsItem}>
            <span className={styles.statsLabel}>Candles:</span> {candleCount}
            {loadingHistory && <span className={styles.histSpinner}>↻</span>}
            {reachedHistoryEndRef.current && <span className={styles.histEnd} title="No hay más historia">·</span>}
          </span>
        </div>
      </div>

      {settingsVisible && (
        <div className={styles.toolbarSecondary}>
          <div className={styles.toolGroup}>
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
          <div className={styles.toolGroup}>
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
        </div>
      )}

      <div className={styles.toolbarDesktop}>
        <div className={styles.toolGroup}>
          <label>Timeframe:</label>
          <div className={styles.tfGroup}>
            {timeframeButtons(styles.tfBtn, styles.tfBtnActive)}
          </div>
        </div>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={loadData}
          disabled={loading}
          title="Refrescar datos"
        >
          <span className={styles.btnIcon}><RefreshIcon size={14} /></span>
          <span>{loading ? 'Cargando…' : 'Refrescar'}</span>
        </button>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => setModalOpen(true)}
          title="Configurar indicadores"
        >
          <span className={styles.btnIcon}><IndicatorsIcon size={14} /></span>
          <span>Indicadores ({visibleIndicatorsCount})</span>
        </button>
        <button
          type="button"
          className={`${styles.refreshBtn} ${replayActive || replayPanelOpen ? styles.replayBtnActive : ''}`}
          onClick={() => setReplayPanelOpen((v) => !v)}
          title={replayActive ? 'Replay activo — abrir panel' : 'Modo Replay (simular formación de vela)'}
          aria-pressed={replayPanelOpen}
        >
          <span className={styles.btnIcon}><ReplayIcon size={14} /></span>
          <span>Replay{replayActive ? ' ●' : ''}</span>
        </button>
        <button
          type="button"
          className={`${styles.refreshBtn} ${styles.settingsBtn}`}
          onClick={() => setSettingsVisible((v) => !v)}
          title={settingsVisible ? 'Ocultar ajustes (crosshair, escala)' : 'Mostrar ajustes (crosshair, escala)'}
          aria-label={settingsVisible ? 'Ocultar ajustes' : 'Mostrar ajustes'}
          aria-pressed={settingsVisible}
        >
          <SlidersIcon size={14} />
        </button>
        <button
          type="button"
          className={`${styles.refreshBtn} ${styles.fullscreenBtn}`}
          onClick={toggleFullscreen}
          title={fullscreen ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}
          aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          aria-pressed={fullscreen}
        >
          {fullscreen ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
        </button>
      </div>
    </div>
  );

  // Variación 24h de la cabecera móvil. Se recalcula en cada render (cada
  // tick de lastPrice); recorre las velas desde el final, así que es barato.
  const priceChange = isMobile ? computePriceChange(candlesRef.current, lastPrice) : null;
  const isLogScale = priceScaleMode === PriceScaleMode.Logarithmic;
  const favoriteCount = tfFavorites.length;

  // Cabecera móvil: par + precio + pantalla completa, y debajo las
  // temporalidades (scroll horizontal). Las herramientas viven abajo.
  const mobileHeader = (
    <>
      <div className={styles.mHeader}>
        <button
          type="button"
          className={styles.mAssetBtn}
          onClick={() => setAssetPickerOpen(true)}
          aria-label={`Cambiar par (actual: ${asset.symbol})`}
        >
          <span className={styles.mAssetText}>
            <span className={styles.mAssetSymbol}>{asset.symbol}</span>
            <span className={styles.mAssetSource}>{asset.datasource}</span>
          </span>
          <ChevronDownIcon size={16} />
        </button>
        <div className={styles.mPrice}>
          <span className={styles.mPriceValue}>
            {lastPrice != null ? formatPrice(Number(lastPrice), pricePrecision) : '—'}
          </span>
          <span className={styles.mPriceMeta}>
            {priceChange && (
              <span
                className={`${styles.mChange} ${priceChange.change > 0 ? styles.mChangeUp : ''} ${priceChange.change < 0 ? styles.mChangeDown : ''}`}
              >
                {formatChange(priceChange.change, pricePrecision)} {formatPercent(priceChange.percent)}
                <span className={styles.mChangeWindow}>24h</span>
              </span>
            )}
            <span className={styles.mLiveStatus}>
              <span className={liveActive ? styles.liveDot : styles.liveDotIdle} />
              {replayActive ? 'Replay' : (liveActive ? 'En vivo' : 'Último')}
            </span>
            {loadingHistory && <span className={styles.histSpinner}>↻</span>}
          </span>
        </div>
        <button
          type="button"
          className={styles.mIconBtn}
          onClick={toggleFullscreen}
          aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          aria-pressed={fullscreen}
        >
          {fullscreen ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      </div>
      <nav className={styles.mTfRow} aria-label="Temporalidad">
        {timeframeButtons(styles.mTfBtn, styles.mTfBtnActive, rowItems(TIMEFRAMES, tfFavorites, timeframe))}
        <button
          type="button"
          className={styles.mTfMore}
          onClick={() => setTfSheetOpen(true)}
          aria-label="Más temporalidades"
          aria-haspopup="dialog"
        >
          <MoreIcon size={18} />
        </button>
        <span className={styles.mTfSpacer} aria-hidden="true" />
        <button
          type="button"
          className={`${styles.mTfBtn} ${styles.mLogBtn} ${isLogScale ? styles.mTfBtnActive : ''}`}
          onClick={() => setPriceScaleMode(isLogScale ? PriceScaleMode.Normal : PriceScaleMode.Logarithmic)}
          aria-pressed={isLogScale}
          aria-label="Escala logarítmica"
        >
          Log
        </button>
      </nav>
    </>
  );

  return (
    <div
      ref={pageRef}
      className={`${styles.page} ${fullscreen ? styles.pageFullscreen : ''}`}
    >
      {isMobile ? mobileHeader : desktopToolbar}

      <div ref={widgetContainerRef} className={styles.widgetContainer}>
        {error && <div className={styles.error}>{error}</div>}
        <div
          ref={containerRef}
          className={styles.chart}
          data-testid="tradingview-chart"
          data-price-precision={pricePrecision}
        />

        <canvas
          ref={drawingsCanvasRef}
          className={styles.drawingsCanvas}
          style={{
            pointerEvents: canvasInteractive || drawings.selectedUid ? 'auto' : (activeTool === 'select' ? 'auto' : 'none'),
            cursor: canvasCursor,
          }}
          onPointerDown={drawings.onPointerDown}
          onPointerMove={drawings.onPointerMove}
          onPointerUp={drawings.onPointerUp}
        />

        {!isMobile && (
          <DrawingToolbar
            activeTool={activeTool}
            onSelectTool={setActiveTool}
            onClear={drawings.clearAll}
            selectedUid={drawings.selectedUid}
            onDeleteSelected={drawings.deleteSelected}
            hasDrawings={drawings.drawings.length > 0}
          />
        )}

        {/* Escritorio: botón flotante para ocultar/mostrar overlays
            informativos. En móvil la opción vive en la hoja de Ajustes. */}
        {!isMobile && (
          <button
            type="button"
            className={`${styles.overlaysToggle} ${overlaysHidden ? styles.overlaysToggleHidden : ''}`}
            onClick={() => setOverlaysHidden((v) => !v)}
            title={overlaysHidden ? 'Mostrar overlays' : 'Ocultar overlays'}
            aria-label={overlaysHidden ? 'Mostrar overlays' : 'Ocultar overlays'}
            aria-pressed={overlaysHidden}
          >
            {overlaysHidden ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
          </button>
        )}

        {!overlaysHidden && futureTimeLabel && (
          <div
            className={styles.futureTimeLabel}
            style={{ left: `${futureTimeLabel.x}px` }}
          >
            {futureTimeLabel.text}
          </div>
        )}

        {!isMobile && !overlaysHidden && ohlcInfo && (
          <div className={styles.ohlcOverlay} aria-label="Valores OHLC">
            <span className={styles.ohlcSymbol}>
              {asset.symbol} · {timeframe.toUpperCase()} · {asset.datasource}
            </span>
            {ohlcValues.map(([label, value]) => (
              <span key={label} className={styles.ohlcGroup}>
                <span className={styles.ohlcLabel}>{label}</span>
                <span className={`${styles.ohlcVal} ${ohlcInfo.upBar ? styles.ohlcUp : styles.ohlcDown}`}>
                  {formatPrice(value, pricePrecision)}
                </span>
              </span>
            ))}
            <span className={`${styles.ohlcChange} ${ohlcInfo.intra >= 0 ? styles.ohlcUp : styles.ohlcDown}`}>
              {formatChange(ohlcInfo.intra, pricePrecision)} ({formatPercent(ohlcInfo.intraPct)})
            </span>
            {ohlcInfo.inter != null && (
              <span className={`${styles.ohlcChange} ${styles.ohlcChangeSecondary} ${ohlcInfo.inter >= 0 ? styles.ohlcUp : styles.ohlcDown}`}>
                {formatChange(ohlcInfo.inter, pricePrecision)} ({formatPercent(ohlcInfo.interPct)})
              </span>
            )}
          </div>
        )}

        {!isMobile && !overlaysHidden && indicatorLegend.length > 0 && (
          <div className={styles.indicatorLegend} aria-label="Valores de indicadores">
            {indicatorLegend.map((ind) => (
              <div key={ind.uid} className={styles.legendRow}>
                <span
                  className={styles.legendDot}
                  style={{ background: ind.values[0]?.color || '#94a3b8' }}
                  aria-hidden="true"
                />
                <span className={styles.legendName}>
                  {formatIndicatorLabel(ind.type, ind.params, ind.label)}
                </span>
                {ind.values.length === 0 ? (
                  <span className={styles.legendNoData}>—</span>
                ) : (
                  <span className={styles.legendValues}>
                    {ind.values.map((v, i) => (
                      <span key={v.role} className={styles.legendValueGroup}>
                        {v.label && <span className={styles.legendValueLabel}>{v.label}:</span>}
                        <span className={styles.legendValue} style={{ color: v.color }}>
                          {formatPrice(v.value, pricePrecision)}
                        </span>
                        {i < ind.values.length - 1 && <span className={styles.legendSep}>·</span>}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Móvil: leyenda compacta. Una línea con el cierre y el cambio de la
            vela (toca para ver O/H/L/C) y chips con el valor de cada
            indicador. Deja libre casi todo el alto del gráfico. */}
        {isMobile && drawMode && (
          <MobileDrawingBanner
            activeTool={activeTool}
            canUndo={drawings.canUndo}
            onUndo={drawings.undo}
            onDone={exitDrawMode}
          />
        )}

        {isMobile && !drawMode && !overlaysHidden && ohlcInfo && (
          <div className={styles.mLegend}>
            <button
              type="button"
              className={styles.mOhlcChip}
              onClick={() => setOhlcExpanded((v) => !v)}
              aria-expanded={ohlcExpanded}
              aria-label={ohlcExpanded ? 'Ocultar valores OHLC' : 'Ver valores OHLC'}
            >
              {(ohlcExpanded ? ohlcValues : ohlcValues.slice(3)).map(([label, value]) => (
                <span key={label} className={styles.ohlcGroup}>
                  <span className={styles.ohlcLabel}>{label}</span>
                  <span className={styles.ohlcVal}>{formatPrice(value, pricePrecision)}</span>
                </span>
              ))}
              <span className={ohlcInfo.intra >= 0 ? styles.ohlcUp : styles.ohlcDown}>
                {formatPercent(ohlcInfo.intraPct)}
              </span>
              <span className={`${styles.mChevron} ${ohlcExpanded ? styles.mChevronOpen : ''}`}>
                <ChevronDownIcon size={12} />
              </span>
            </button>
            {indicatorLegend.length > 0 && (
              <div className={styles.mLegendChips}>
                {indicatorLegend.map((ind) => (
                  <span key={ind.uid} className={styles.mLegendChip}>
                    <span
                      className={styles.legendDot}
                      style={{ background: ind.values[0]?.color || '#94a3b8' }}
                      aria-hidden="true"
                    />
                    {formatIndicatorLabel(ind.type, ind.params, ind.label)}
                    {ind.values[0] && (
                      <span style={{ color: ind.values[0].color }}>
                        {formatPrice(ind.values[0].value, pricePrecision)}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <ReplayPanel
          open={replayPanelOpen}
          onClose={() => setReplayPanelOpen(false)}
          htfTimeframe={timeframe}
          controller={replay}
        />
      </div>

      {isMobile && (drawMode ? (
        <MobileDrawingBar
          activeTool={activeTool}
          onSelectTool={setActiveTool}
          selectedUid={drawings.selectedUid}
          onDeleteSelected={drawings.deleteSelected}
        />
      ) : (
        <MobileTabBar
          indicatorsCount={visibleIndicatorsCount}
          replayActive={replayActive}
          replayOpen={replayPanelOpen}
          onIndicators={() => setModalOpen(true)}
          onDraw={() => { setReplayPanelOpen(false); setDrawMode(true); }}
          onReplay={() => setReplayPanelOpen((v) => !v)}
          onSettings={() => setSettingsSheetOpen(true)}
        />
      ))}

      {isMobile && (
        <BottomSheet open={tfSheetOpen} title="Temporalidad" onClose={() => setTfSheetOpen(false)}>
          <div className={mobileStyles.field}>
            <span className={mobileStyles.fieldHint}>
              La estrella fija la temporalidad en la barra superior.
            </span>
            <ul className={mobileStyles.tfList}>
              {TIMEFRAMES.map((t) => {
                const active = timeframe === t.value;
                const fav = tfFavorites.includes(t.value);
                // La última favorita no se puede quitar: la fila nunca queda vacía.
                const locked = fav && favoriteCount <= 1;
                return (
                  <li key={t.value} className={mobileStyles.tfItem}>
                    <button
                      type="button"
                      className={`${mobileStyles.tfSelect} ${active ? mobileStyles.tfSelectActive : ''}`}
                      onClick={() => { setTimeframe(t.value); setTfSheetOpen(false); }}
                      aria-pressed={active}
                    >
                      {t.label}
                    </button>
                    <button
                      type="button"
                      className={`${mobileStyles.iconBtn} ${fav ? mobileStyles.starOn : ''}`}
                      onClick={() => setTfFavorites((f) => toggleFavorite(f, t.value, TIMEFRAME_VALUES))}
                      aria-pressed={fav}
                      aria-label={fav ? `Quitar ${t.label} de favoritas` : `Marcar ${t.label} como favorita`}
                      disabled={locked}
                      title={locked ? 'Debe quedar al menos una favorita' : undefined}
                    >
                      <StarIcon filled={fav} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </BottomSheet>
      )}

      {isMobile && (
        <MobileSettingsSheet
          open={settingsSheetOpen}
          onClose={() => setSettingsSheetOpen(false)}
          crosshairModes={CROSSHAIR_MODES}
          crosshairMode={crosshairMode}
          onCrosshairMode={setCrosshairMode}
          priceScaleModes={PRICE_SCALE_MODES}
          priceScaleMode={priceScaleMode}
          onPriceScaleMode={setPriceScaleMode}
          overlaysHidden={overlaysHidden}
          onToggleOverlays={() => setOverlaysHidden((v) => !v)}
          onRefresh={loadData}
          loading={loading}
          candleCount={candleCount}
          hasDrawings={drawings.drawings.length > 0}
          onClearDrawings={drawings.clearAll}
        />
      )}

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

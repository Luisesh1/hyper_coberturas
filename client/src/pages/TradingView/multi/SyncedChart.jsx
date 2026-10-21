import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  createChart, CandlestickSeries, CrosshairMode, LineStyle, TrackingModeExitMode,
} from 'lightweight-charts';
import { marketApi } from '../../../services/api';
import {
  SYNC_COLORS,
  TF_SECONDS,
  MULTI_TIMEFRAMES,
  resolveSyncedTime,
  statusLabel,
  compactStatusLabel,
  formatSyncTime,
} from './crosshairSync';
import {
  THEME,
  LIVE_POLL_MS,
  DEFAULT_PRICE_PRECISION,
  DEFAULT_CROSSHAIR_LINE,
  getPricePrecisionFromCandles,
  getPriceFormatOptions,
  formatPrice,
} from './chartTheme';
import { getInitialChartViewport } from '../chartViewport';
import { createIndicatorsController } from '../indicators/renderAdapter';
import { ChevronDownIcon } from '../components/icons';
import styles from './SyncedChart.module.css';

const CANDLE_LIMIT = 500;
const POLL_LIMIT = 2;
const NO_INDICATORS = [];

function toBar(c) {
  return {
    time: Math.floor(c.time / 1000),
    open: c.open, high: c.high, low: c.low, close: c.close,
  };
}

function crosshairLines(color, style, labelBackgroundColor = color, showHorz = true) {
  const line = { color, style, labelBackgroundColor };
  return {
    crosshair: {
      vertLine: line,
      horzLine: { ...line, visible: showHorz, labelVisible: showHorz },
    },
  };
}

const DEFAULT_LINES = crosshairLines(
  DEFAULT_CROSSHAIR_LINE.color,
  DEFAULT_CROSSHAIR_LINE.style,
  DEFAULT_CROSSHAIR_LINE.labelBackgroundColor,
);

function findCandle(candles, timeSec) {
  if (timeSec == null) return null;
  // Velas ascendentes: búsqueda binaria por apertura exacta.
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Math.floor(candles[mid].time / 1000);
    if (t === timeSec) return candles[mid];
    if (t < timeSec) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

export default function SyncedChart({
  asset,
  timeframe,
  timeframes = MULTI_TIMEFRAMES,
  onTimeframeChange,
  index,
  syncEnabled = true,
  sync = null,
  syncPrice = true,
  onAssetClick,
  onPointer,
  onLastPrice,
  indicators = NO_INDICATORS,
  compact = false,
}) {
  const selectId = useId();
  const hostRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const indicatorsCtrlRef = useRef(null);
  const candlesRef = useRef([]);
  const appliedRef = useRef('none'); // 'none' | 'source' | 'target'
  const linesKeyRef = useRef('default');
  const onPointerRef = useRef(onPointer);
  // El chart se crea una vez; el modo compacto se lee al crearlo (la página
  // monta otro árbol al cruzar el breakpoint, así que no cambia en vida).
  const compactRef = useRef(compact);
  const onLastPriceRef = useRef(onLastPrice);
  const indexRef = useRef(index);
  onPointerRef.current = onPointer;
  onLastPriceRef.current = onLastPrice;
  indexRef.current = index;

  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [precision, setPrecision] = useState(DEFAULT_PRICE_PRECISION);
  const [reloadKey, setReloadKey] = useState(0);
  const [resolution, setResolution] = useState(null);

  const emitPointer = useCallback((value) => {
    onPointerRef.current?.(indexRef.current, value);
  }, []);

  const applyLines = useCallback((baseKey, options, hideHorz = false) => {
    // La clave incluye si la línea horizontal está oculta (syncPrice=false en
    // destino) para no reutilizar opciones cacheadas obsoletas.
    const key = hideHorz ? `${baseKey}:time` : baseKey;
    if (linesKeyRef.current === key) return;
    linesKeyRef.current = key;
    chartRef.current?.applyOptions(options);
  }, []);

  // --- 1) Crea el chart una vez ---
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const chart = createChart(hostRef.current, {
      autoSize: true,
      layout: {
        background: { color: THEME.background },
        textColor: THEME.text,
      },
      grid: {
        vertLines: { color: THEME.grid },
        horzLines: { color: THEME.grid },
      },
      rightPriceScale: { borderColor: THEME.border },
      timeScale: {
        borderColor: THEME.border,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
      // Táctil: al soltar el dedo se sale del modo seguimiento. Con el valor
      // por defecto (OnNextTap) el gráfico origen se quedaba con un puntero
      // gris y el siguiente arrastre movía el puntero en vez de desplazar.
      trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: THEME.up,
      downColor: THEME.down,
      borderUpColor: THEME.upEdge,
      borderDownColor: THEME.downEdge,
      wickUpColor: THEME.upEdge,
      wickDownColor: THEME.downEdge,
      priceFormat: getPriceFormatOptions(DEFAULT_PRICE_PRECISION),
    });
    chartRef.current = chart;
    seriesRef.current = series;
    // Indicadores guardados del usuario (overlays en el panel de precio y
    // osciladores en sub-paneles), mismo controlador que /trading-view.
    indicatorsCtrlRef.current = createIndicatorsController(chart, { compact: compactRef.current });

    // Solo los movimientos reales del usuario traen `sourceEvent`; los
    // eventos sintéticos (actualización de datos, salida del ratón) se ignoran
    // para no generar ecos ni punteros fantasma.
    const handleMove = (param) => {
      if (!param?.sourceEvent) return;
      if (param.time == null || !param.point) {
        emitPointer(null);
        return;
      }
      // En un sub-panel (oscilador) la `y` no es de la escala de precio: se
      // propaga el cierre de la vela señalada.
      const inSubPane = param.paneIndex != null && param.paneIndex !== 0;
      const price = inSubPane
        ? findCandle(candlesRef.current, param.time)?.close
        : series.coordinateToPrice(param.point.y);
      if (price == null || !Number.isFinite(price)) {
        emitPointer(null);
        return;
      }
      emitPointer({ timeSec: param.time, price });
    };
    chart.subscribeCrosshairMove(handleMove);

    return () => {
      chart.unsubscribeCrosshairMove(handleMove);
      indicatorsCtrlRef.current?.removeAll();
      indicatorsCtrlRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      appliedRef.current = 'none';
      linesKeyRef.current = 'default';
    };
  }, [emitPointer]);

  // --- 2) Carga velas al cambiar activo o temporalidad ---
  useEffect(() => {
    if (!asset?.symbol || !timeframe) return undefined;
    let cancelled = false;
    candlesRef.current = [];
    setCandles([]);
    setLoading(true);
    setError(null);
    seriesRef.current?.setData([]);

    (async () => {
      try {
        const data = await marketApi.getCandles({
          asset: asset.symbol,
          datasource: asset.datasource || 'hyperliquid',
          timeframe,
          limit: CANDLE_LIMIT,
        });
        if (cancelled) return;
        if (!Array.isArray(data) || data.length === 0) {
          setError('No se recibieron velas del servidor.');
          return;
        }
        const next = [...data];
        candlesRef.current = next;
        const nextPrecision = getPricePrecisionFromCandles(next);
        seriesRef.current?.applyOptions({ priceFormat: getPriceFormatOptions(nextPrecision) });
        seriesRef.current?.setData(next.map(toBar));
        // Mismo encuadre que la página principal: la última vela queda algo
        // separada de la escala de precios para ver de un vistazo el final.
        const { rightOffset, barSpacing } = getInitialChartViewport(
          hostRef.current?.clientWidth,
          next.length,
        );
        chartRef.current?.timeScale().applyOptions({ barSpacing, rightOffset });
        chartRef.current?.timeScale().scrollToRealTime();
        setPrecision(nextPrecision);
        setCandles(next);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Error cargando datos de mercado.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [asset?.symbol, asset?.datasource, timeframe, reloadKey]);

  // --- 3) Polling en vivo: pide las últimas velas y las fusiona por `time` ---
  useEffect(() => {
    if (!asset?.symbol || !timeframe) return undefined;
    const intervalMs = LIVE_POLL_MS[timeframe] || 15_000;
    let cancelled = false;

    async function tick() {
      if (cancelled || document.hidden) return;
      const current = candlesRef.current;
      if (current.length === 0) return;
      try {
        const recent = await marketApi.getCandles({
          asset: asset.symbol,
          datasource: asset.datasource || 'hyperliquid',
          timeframe,
          limit: POLL_LIMIT,
        });
        if (cancelled || !Array.isArray(recent) || recent.length === 0) return;
        if (candlesRef.current !== current) return; // recarga en curso
        // Hueco (pestaña oculta, móvil bloqueado, red caída): `limit: 2` no
        // basta para rellenarlo, así que se recarga el histórico completo.
        const tfMs = (TF_SECONDS[timeframe] || 0) * 1000;
        if (tfMs > 0 && recent[0].time > current[current.length - 1].time + tfMs) {
          setReloadKey((k) => k + 1);
          return;
        }
        const next = [...current];
        let changed = false;
        for (const c of recent) {
          const last = next[next.length - 1];
          if (c.time === last.time) {
            next[next.length - 1] = { ...last, ...c };
          } else if (c.time > last.time) {
            next.push(c);
            if (next.length > CANDLE_LIMIT) next.shift();
          } else {
            continue;
          }
          seriesRef.current?.update(toBar(c));
          changed = true;
        }
        if (!changed) return;
        candlesRef.current = next;
        setCandles(next);
      } catch (err) {
        console.warn('[SyncedChart] live poll error:', err?.message);
      }
    }

    // Al volver a la pestaña (o desbloquear el móvil) se recarga: mientras
    // estuvo oculta no hubo polling y podría faltar más de una vela.
    function onVisibility() {
      if (!document.hidden) setReloadKey((k) => k + 1);
    }

    const firstId = setTimeout(tick, Math.min(intervalMs, 3_000));
    const intervalId = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(firstId);
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [asset?.symbol, asset?.datasource, timeframe]);

  // --- 3a) Indicadores: al cargar, en cada polling con cambios y al cambiar
  // la lista. `render` ya omite los ocultos (`visible === false`). Sin velas
  // (recarga o error) se quitan para no dejar los del par/temporalidad previo.
  useEffect(() => {
    const ctrl = indicatorsCtrlRef.current;
    if (!ctrl) return;
    if (candles.length === 0) ctrl.render(NO_INDICATORS, candles);
    else ctrl.render(indicators, candles);
  }, [indicators, candles]);

  // --- 3b) Último cierre hacia la página (precio de la barra superior) ---
  useEffect(() => {
    const last = candles[candles.length - 1];
    if (last) onLastPriceRef.current?.(indexRef.current, last.close);
  }, [candles]);

  // --- 4) Aplica el puntero sincronizado ---
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    if (!syncEnabled || !sync) {
      if (appliedRef.current !== 'none') {
        if (appliedRef.current === 'target') chart.clearCrosshairPosition();
        appliedRef.current = 'none';
      }
      applyLines('default', DEFAULT_LINES);
      setResolution(null);
      return;
    }

    if (sync.sourceIndex === index) {
      // Gráfico origen: puntero nativo, verde y continuo.
      appliedRef.current = 'source';
      applyLines('source', crosshairLines(SYNC_COLORS.exact, LineStyle.Solid));
      setResolution(resolveSyncedTime(sync.timeSec, candles, TF_SECONDS[timeframe], null));
      return;
    }

    const res = resolveSyncedTime(
      sync.timeSec,
      candles,
      TF_SECONDS[timeframe],
      chart.timeScale().getVisibleRange(),
    );
    setResolution(res);

    if (res.status === 'exact' || res.status === 'near') {
      const hideHorz = !syncPrice;
      applyLines(
        res.status,
        crosshairLines(SYNC_COLORS[res.status], LineStyle.Dashed, SYNC_COLORS[res.status], !hideHorz),
        hideHorz,
      );
      // Solo tiempo: el precio es el cierre de la vela resuelta en este activo.
      const price = hideHorz
        ? (findCandle(candles, res.candleTimeSec)?.close ?? sync.price)
        : sync.price;
      chart.setCrosshairPosition(price, res.candleTimeSec, series);
      appliedRef.current = 'target';
    } else {
      chart.clearCrosshairPosition();
      applyLines(
        'out',
        crosshairLines(SYNC_COLORS.out, LineStyle.Dashed, SYNC_COLORS.out, syncPrice),
        !syncPrice,
      );
      appliedRef.current = 'target';
    }
  }, [sync, syncEnabled, syncPrice, candles, index, timeframe, applyLines]);

  const handleLeave = useCallback(() => emitPointer(null), [emitPointer]);

  const isSource = !!sync && sync.sourceIndex === index;
  const showSync = syncEnabled && !!sync && !!resolution;
  const chipStatus = showSync ? (isSource ? 'source' : resolution.status) : null;
  const chipText = showSync ? statusLabel(resolution, { isSource }) : '';
  const chipShort = showSync && compact ? compactStatusLabel(resolution, { isSource }) : chipText;
  const outSide = showSync && !isSource && resolution.status === 'out' ? resolution.side : null;

  const shownCandle = useMemo(() => {
    const resolved = showSync ? findCandle(candles, resolution.candleTimeSec) : null;
    return resolved || candles[candles.length - 1] || null;
  }, [showSync, candles, resolution]);

  const tfOptions = timeframes.includes(timeframe) ? timeframes : [timeframe, ...timeframes];

  return (
    <section
      className={`${styles.panel} ${compact ? styles.compact : ''}`}
      data-testid={`synced-chart-${index}`}
      aria-label={`Gráfico ${asset?.symbol || ''} ${timeframe}`}
      onMouseLeave={handleLeave}
      onTouchEnd={handleLeave}
      onTouchCancel={handleLeave}
    >
      <header className={styles.header}>
        {onAssetClick && (
          <button
            type="button"
            className={styles.assetBtn}
            data-testid={`asset-btn-${index}`}
            aria-label={`Cambiar activo (actual: ${asset?.symbol || ''})`}
            title={[asset?.name || asset?.symbol, asset?.datasource].filter(Boolean).join(' · ')}
            onClick={() => onAssetClick(index)}
          >
            <span className={styles.assetSymbol}>{asset?.symbol}</span>
            {!compact && asset?.datasource && (
              <span className={styles.assetSource}>{asset.datasource}</span>
            )}
            <ChevronDownIcon size={14} />
          </button>
        )}
        <label className={styles.tfLabel} htmlFor={selectId}>
          <span className={styles.srOnly}>Temporalidad</span>
          <select
            id={selectId}
            className={styles.tfSelect}
            value={timeframe}
            onChange={(e) => onTimeframeChange?.(e.target.value)}
          >
            {tfOptions.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </label>

        {shownCandle && (compact ? (
          <span className={styles.close} data-testid={`synced-close-${index}`}>
            {formatPrice(shownCandle.close, precision)}
          </span>
        ) : (
          <dl className={styles.ohlc} data-testid={`synced-ohlc-${index}`}>
            <div><dt>O</dt><dd>{formatPrice(shownCandle.open, precision)}</dd></div>
            <div><dt>H</dt><dd>{formatPrice(shownCandle.high, precision)}</dd></div>
            <div><dt>L</dt><dd>{formatPrice(shownCandle.low, precision)}</dd></div>
            <div>
              <dt>C</dt>
              <dd data-testid={`synced-close-${index}`}>{formatPrice(shownCandle.close, precision)}</dd>
            </div>
          </dl>
        ))}

        {chipStatus && (
          <span
            className={`${styles.chip} ${styles[`chip_${chipStatus}`]}`}
            data-testid={`sync-chip-${index}`}
            data-status={chipStatus}
            title={chipText}
          >
            <span className={styles.chipDot} aria-hidden="true" />
            <span
              className={styles.chipText}
              data-testid={`sync-chip-text-${index}`}
              aria-hidden={chipShort !== chipText ? 'true' : undefined}
            >
              {chipShort}
            </span>
            {chipShort !== chipText && <span className={styles.srOnly}>{chipText}</span>}
          </span>
        )}
      </header>

      <div className={styles.body}>
        <div ref={hostRef} className={styles.host} onMouseLeave={handleLeave} />

        {outSide && (
          <div
            className={`${styles.edge} ${outSide === 'left' ? styles.edgeLeft : styles.edgeRight}`}
            data-testid={`sync-out-${index}`}
          >
            <span>
              {outSide === 'left' ? '◀︎ ' : ''}
              {formatSyncTime(sync.timeSec)} fuera de vista
              {outSide === 'right' ? ' ▶︎' : ''}
            </span>
          </div>
        )}

        {loading && !error && (
          <div className={styles.overlay} role="status">Cargando velas…</div>
        )}
        {error && (
          <div className={styles.overlay} role="alert">
            <span>{error}</span>
            <button type="button" className={styles.retry} onClick={() => setReloadKey((k) => k + 1)}>
              Reintentar
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

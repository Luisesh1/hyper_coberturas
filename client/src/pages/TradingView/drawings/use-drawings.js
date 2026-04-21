import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsApi } from '../../../services/api';
import { TOOLS, newDrawing } from './catalog';
import { renderDrawing } from './renderer';
import { findHitDrawing } from './hit-test';

// Convierte un evento mouse a coordenadas relativas al canvas.
function eventToLocal(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

// Devuelve una función `project({ time, price }) → { x, y }` o null si no
// hay chart listo. `time` está en segundos.
// Si el tiempo está más allá de la última vela, proyecta vía eje lógico
// usando la duración del timeframe (soporta dibujos extendidos al futuro).
function makeProjector(chartRef, seriesRef, candlesRef, timeframe) {
  const chart = chartRef.current;
  const series = seriesRef.current;
  if (!chart || !series) return () => null;
  const timeScale = chart.timeScale();
  const candles = candlesRef?.current || [];
  const lastIdx = candles.length - 1;
  const lastTimeSec = lastIdx >= 0 ? Math.floor(candles[lastIdx].time / 1000) : null;
  const tfSec = guessSecondsPerBar(timeframe);
  return (anchor) => {
    if (!anchor) return null;
    let x = null;
    if (anchor.time != null) {
      x = timeScale.timeToCoordinate(anchor.time);
      if (x == null && lastTimeSec != null && anchor.time > lastTimeSec) {
        const logical = lastIdx + (anchor.time - lastTimeSec) / tfSec;
        x = timeScale.logicalToCoordinate(logical);
      }
      if (x == null) return null;
    }
    let y = null;
    if (anchor.price != null) {
      y = series.priceToCoordinate(anchor.price);
      if (y == null) return null;
    }
    return { x, y };
  };
}

// Convierte clic en canvas → { time, price }.
// Si cae en el área futura (sin vela real), usa el eje lógico + timeframe
// para calcular un tiempo proyectado.
function makeInverseProjector(chartRef, seriesRef, candlesRef, timeframe) {
  return (px, py) => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return null;
    const timeScale = chart.timeScale();
    const price = series.coordinateToPrice(py);
    if (price == null) return null;
    let time = timeScale.coordinateToTime(px);
    if (time == null) {
      const logical = timeScale.coordinateToLogical(px);
      const candles = candlesRef?.current || [];
      const lastIdx = candles.length - 1;
      if (logical == null || lastIdx < 0) return null;
      const lastTimeSec = Math.floor(candles[lastIdx].time / 1000);
      const tfSec = guessSecondsPerBar(timeframe);
      time = lastTimeSec + (logical - lastIdx) * tfSec;
    }
    return {
      time: typeof time === 'number' ? time : Number(time),
      price: Number(price),
    };
  };
}

function guessSecondsPerBar(timeframe) {
  const map = {
    '1m': 60, '5m': 300, '15m': 900, '1h': 3600,
    '4h': 14400, '1d': 86400, '1w': 604800, '1M': 2592000,
  };
  return map[timeframe] || 60;
}

// ------------------------------------------------------------------
// Hook principal
// ------------------------------------------------------------------

export function useDrawings({
  chartRef,
  seriesRef,
  candlesRef,
  containerRef,
  canvasRef,
  symbol,
  timeframe,
  activeTool,
  setActiveTool,
  onNotify,
}) {
  const [drawings, setDrawings] = useState([]);
  const [selectedUid, setSelectedUid] = useState(null);
  const [rulerSnapshot, setRulerSnapshot] = useState(null); // ruler efímero
  const draftRef = useRef(null); // { type, anchors: [...] }
  const cursorRef = useRef(null); // { x, y } última posición
  const saveTimerRef = useRef(null);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;

  // --------------- Carga inicial por símbolo ---------------
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    settingsApi.getChartDrawings(symbol)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.drawings) ? res.drawings : [];
        setDrawings(list);
        setSelectedUid(null);
        draftRef.current = null;
        setRulerSnapshot(null);
      })
      .catch((err) => {
        if (!cancelled) onNotify?.('alert', `No se pudieron cargar dibujos: ${err.message}`);
      });
    return () => { cancelled = true; };
  }, [symbol, onNotify]);

  // --------------- Persistencia debounced ---------------
  const schedulePersist = useCallback((nextList) => {
    if (!symbol) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      settingsApi.saveChartDrawings(symbol, nextList).catch((err) => {
        onNotify?.('error', `No se pudo guardar: ${err.message}`);
      });
    }, 300);
  }, [symbol, onNotify]);

  // --------------- Helpers de render ---------------
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    // Ajusta tamaño canvas si cambió
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const project = makeProjector(chartRef, seriesRef, candlesRef, timeframe);
    const commonOpts = {
      width: rect.width,
      height: rect.height,
      secondsPerBar: guessSecondsPerBar(timeframe),
    };

    // Render persistentes
    for (const d of drawingsRef.current) {
      if (d.visible === false) continue;
      renderDrawing(ctx, d, project, { ...commonOpts, selected: d.uid === selectedUid });
    }

    // Render draft (en construcción)
    if (draftRef.current && draftRef.current.anchors.length > 0) {
      const draft = draftRef.current;
      // Si hay solo 1 anchor y tenemos cursor, añadimos el anchor provisional
      let anchorsForDraw = draft.anchors;
      if (draft.anchors.length === 1 && cursorRef.current && TOOLS[draft.type]?.anchors === 2) {
        const inverse = makeInverseProjector(chartRef, seriesRef, candlesRef, timeframe);
        const provisional = inverse(cursorRef.current.x, cursorRef.current.y);
        if (provisional) anchorsForDraw = [...draft.anchors, provisional];
      }
      if (anchorsForDraw.length === (TOOLS[draft.type]?.anchors || 1)) {
        renderDrawing(ctx, { ...draft, anchors: anchorsForDraw }, project, commonOpts);
      } else if (anchorsForDraw.length === 1 && draft.type === 'horizontal') {
        renderDrawing(ctx, { ...draft, anchors: anchorsForDraw }, project, commonOpts);
      }
    }

    // Snapshot de regla
    if (rulerSnapshot) {
      renderDrawing(ctx, { ...rulerSnapshot, type: 'ruler' }, project, commonOpts);
    }

    ctx.restore();
  }, [chartRef, seriesRef, containerRef, canvasRef, timeframe, selectedUid, rulerSnapshot]);

  // --------------- Redraw cuando cambian cosas observables ---------------
  useEffect(() => { redraw(); }, [drawings, selectedUid, rulerSnapshot, timeframe, redraw]);

  // Suscripción a pan/zoom del chart + resize del contenedor
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !containerRef.current) return undefined;
    const ts = chart.timeScale();
    const onRange = () => redraw();
    ts.subscribeVisibleLogicalRangeChange(onRange);

    const ro = new ResizeObserver(() => redraw());
    ro.observe(containerRef.current);

    const onWinResize = () => redraw();
    window.addEventListener('resize', onWinResize);

    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(onRange);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
    };
  }, [chartRef, containerRef, redraw]);

  // --------------- Mouse handlers ---------------
  const onMouseDown = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const local = eventToLocal(event, canvas);
    cursorRef.current = local;

    const inverse = makeInverseProjector(chartRef, seriesRef, candlesRef, timeframe);

    // Sin herramienta activa (o "select"): hit-test para selección
    if (!activeTool || activeTool === 'select') {
      const project = makeProjector(chartRef, seriesRef, candlesRef, timeframe);
      const rect = canvas.getBoundingClientRect();
      const hit = findHitDrawing(drawingsRef.current, local.x, local.y, project, rect.width);
      setSelectedUid(hit ? hit.uid : null);
      return;
    }

    const meta = TOOLS[activeTool];
    if (!meta) return;

    const coords = inverse(local.x, local.y);
    if (!coords) return;

    if (activeTool === 'horizontal') {
      const next = newDrawing('horizontal');
      next.anchors = [{ price: coords.price }];
      const updated = [...drawingsRef.current, next];
      setDrawings(updated);
      schedulePersist(updated);
      setActiveTool?.(null);
      return;
    }

    if (activeTool === 'ruler') {
      // 1er click fija A; 2º click fija B y congela snapshot; 3er click limpia
      if (!draftRef.current) {
        draftRef.current = { type: 'ruler', anchors: [coords] };
      } else if (draftRef.current.anchors.length === 1) {
        const snapshot = { anchors: [draftRef.current.anchors[0], coords] };
        setRulerSnapshot(snapshot);
        draftRef.current = null;
      } else {
        draftRef.current = null;
        setRulerSnapshot(null);
      }
      redraw();
      return;
    }

    // trendline, rectangle, fib: drag (mousedown=A, mouseup=B)
    draftRef.current = { type: activeTool, anchors: [coords], style: { ...(meta.defaultStyle || {}) } };
    redraw();
  }, [activeTool, canvasRef, chartRef, seriesRef, candlesRef, timeframe, schedulePersist, setActiveTool, redraw]);

  const onMouseMove = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    cursorRef.current = eventToLocal(event, canvas);
    if (draftRef.current || activeTool === 'ruler' || (!activeTool && !selectedUid)) {
      redraw();
    }
  }, [canvasRef, activeTool, selectedUid, redraw]);

  const onMouseUp = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const local = eventToLocal(event, canvas);
    const inverse = makeInverseProjector(chartRef, seriesRef, candlesRef, timeframe);

    const draft = draftRef.current;
    if (!draft) return;

    // Ruler usa click-to-click, no drag
    if (draft.type === 'ruler') return;

    if (draft.anchors.length === 1) {
      const coords = inverse(local.x, local.y);
      if (!coords) {
        draftRef.current = null;
        redraw();
        return;
      }
      // Ignorar si el drag fue demasiado corto
      const first = makeProjector(chartRef, seriesRef, candlesRef, timeframe)(draft.anchors[0]);
      const distSq = first ? (first.x - local.x) ** 2 + (first.y - local.y) ** 2 : 0;
      if (distSq < 9) {
        draftRef.current = null;
        redraw();
        return;
      }

      const next = newDrawing(draft.type);
      if (!next) { draftRef.current = null; return; }
      next.anchors = [draft.anchors[0], coords];
      const updated = [...drawingsRef.current, next];
      setDrawings(updated);
      schedulePersist(updated);
      draftRef.current = null;
      setActiveTool?.(null);
    }
  }, [canvasRef, chartRef, seriesRef, candlesRef, timeframe, schedulePersist, setActiveTool, redraw]);

  const onKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      if (draftRef.current || rulerSnapshot) {
        draftRef.current = null;
        setRulerSnapshot(null);
        redraw();
      }
      setActiveTool?.(null);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedUid) {
        const updated = drawingsRef.current.filter((d) => d.uid !== selectedUid);
        setDrawings(updated);
        schedulePersist(updated);
        setSelectedUid(null);
      }
    }
  }, [rulerSnapshot, selectedUid, schedulePersist, setActiveTool, redraw]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  const clearAll = useCallback(() => {
    setDrawings([]);
    schedulePersist([]);
    setSelectedUid(null);
    setRulerSnapshot(null);
    draftRef.current = null;
  }, [schedulePersist]);

  const deleteSelected = useCallback(() => {
    if (!selectedUid) return;
    const updated = drawingsRef.current.filter((d) => d.uid !== selectedUid);
    setDrawings(updated);
    schedulePersist(updated);
    setSelectedUid(null);
  }, [selectedUid, schedulePersist]);

  return {
    drawings,
    selectedUid,
    rulerSnapshot,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    clearAll,
    deleteSelected,
    redraw,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineSeries, LineStyle } from 'lightweight-charts';
import { marketApi } from '../../../services/api';
import {
  addOverlay,
  removeOverlay,
  replaceOverlay as replaceModel,
  toggleHidden as toggleHiddenModel,
  setColor as setColorModel,
  focusOverlay,
  loadOverlays,
  saveOverlays,
  isSameAsMain,
  alignToMain,
  splitTraded,
  shortLabel,
} from './overlayModel';

// Superposiciones dentro del chart principal: N LineSeries (2 por opción:
// negociada + sin operaciones), la enfocada en el eje izquierdo y el resto en
// escalas overlay invisibles `ov-<id>`.

export const UNTRADED_COLOR = '#a8a29e';
export const DIM_ALPHA = 0.55;
const FOCUSED_WIDTH = 2.2;
const OTHER_WIDTH = 1.5;
const OV_SCALE_MARGINS = { top: 0.12, bottom: 0.12 };
const DEFAULT_BORDER = 'rgba(120,130,145,0.25)';
const ASSET_LIMIT = 1000;
const MAX_PAGES = 20;

export const OVERLAY_TF_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

// '#26a69a' | 'rgb(..)' | 'rgba(..)' → 'rgba(r,g,b,alpha)'. Si no se entiende, se devuelve tal cual.
export function withAlpha(color, alpha) {
  if (typeof color !== 'string') return color;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color.trim());
  if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})`;
  return color;
}

function candleOptions(colors, dim) {
  const c = (x) => (dim ? withAlpha(x, DIM_ALPHA) : x);
  return {
    upColor: c(colors.up),
    downColor: c(colors.down),
    borderUpColor: c(colors.upEdge),
    borderDownColor: c(colors.downEdge),
    wickUpColor: c(colors.upEdge),
    wickDownColor: c(colors.downEdge),
  };
}

// El foco sólo puede estar en una superposición dibujable (visible y distinta
// del principal). Si no lo está, pasa a la primera dibujable; si no hay
// ninguna, queda sin foco.
function ensureFocus(state, mainAsset) {
  const drawable = (o) => !o.hidden && !isSameAsMain(o, mainAsset);
  const focused = state.items.find((o) => o.id === state.focusedId);
  if (focused && drawable(focused)) return state;
  const next = state.items.find(drawable)?.id ?? null;
  return next === state.focusedId ? state : { ...state, focusedId: next };
}

// Precisión según la magnitud de los valores (XRP, TRX o primas pequeñas).
function priceFormatFor(points) {
  let min = Infinity;
  for (const p of points) if (p.value !== undefined && p.value > 0 && p.value < min) min = p.value;
  if (!Number.isFinite(min) || min >= 1) return { type: 'price', precision: 2, minMove: 0.01 };
  const precision = Math.min(8, Math.max(2, Math.ceil(-Math.log10(min)) + 3));
  return { type: 'price', precision, minMove: 10 ** -precision };
}

const toLine = (p) => ('value' in p && p.value !== undefined ? { time: p.time, value: p.value } : { time: p.time });

function indexAt(points, timeSec) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = points[mid].time;
    if (t === timeSec) return mid;
    if (t < timeSec) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

const hasValue = (p) => p && p.value !== undefined && p.value !== null;

export function useChartOverlays({
  chartRef,
  candleSeriesRef,
  mainAsset,
  timeframe,
  enabled = true,
  candleColors,
  storage = globalThis.localStorage,
}) {
  const [state, setState] = useState(() => ensureFocus(loadOverlays(storage), mainAsset));
  const [loadStatus, setLoadStatus] = useState({});

  // Refs con lo último para que syncMain/reconcile no dependan del render.
  const stateRef = useRef(state);
  stateRef.current = state;
  const propsRef = useRef({});
  propsRef.current = { mainAsset, timeframe, enabled, candleColors };

  const seriesRef = useRef(new Map()); // id -> { kind, main, untraded, scaleId, priceFormat }
  const chartUsedRef = useRef(null);
  const cacheRef = useRef(new Map()); // id -> { candles: Map<ms, candle>, from, to }
  const alignedRef = useRef(new Map()); // id -> points (time s)
  const mainRef = useRef(null);
  const epochRef = useRef(0);
  const dimmedRef = useRef(null);
  const signatureRef = useRef(null);

  const setStatusFor = useCallback((id, s) => {
    setLoadStatus((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }));
  }, []);

  const drawnOverlays = () => {
    const { enabled: en, mainAsset: ma } = propsRef.current;
    if (!en) return [];
    return stateRef.current.items.filter((o) => !o.hidden && !isSameAsMain(o, ma));
  };

  const applyData = (id) => {
    const entry = seriesRef.current.get(id);
    const points = alignedRef.current.get(id);
    if (!entry || !points) return;
    const pf = priceFormatFor(points);
    if (!entry.priceFormat || entry.priceFormat.precision !== pf.precision) {
      entry.main.applyOptions({ priceFormat: pf });
      entry.untraded?.applyOptions({ priceFormat: pf });
      entry.priceFormat = pf;
    }
    if (entry.kind === 'option') {
      const { traded, untraded } = splitTraded(points);
      entry.main.setData(traded.map(toLine));
      entry.untraded.setData(untraded.map(toLine));
    } else {
      entry.main.setData(points.map(toLine));
    }
  };

  const realign = (id) => {
    const cache = cacheRef.current.get(id);
    const main = mainRef.current;
    if (!cache || !main?.length) return;
    const tfMs = OVERLAY_TF_MS[propsRef.current.timeframe] ?? 60_000;
    const points = alignToMain(main, [...cache.candles.values()], tfMs);
    alignedRef.current.set(id, points);
    applyData(id);
    if (cache.loaded) setStatusFor(id, points.some(hasValue) ? 'ready' : 'empty');
  };

  const fetchRange = async (overlay, timeframeKey, start, end) => {
    if (overlay.kind === 'option') {
      return marketApi.getOptionCandles({
        instrument: overlay.option.instrument, timeframe: timeframeKey, startTime: start, endTime: end,
      });
    }
    const tfMs = OVERLAY_TF_MS[timeframeKey] ?? 60_000;
    const out = [];
    let from = start;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await marketApi.getCandles({
        asset: overlay.asset.symbol, datasource: overlay.asset.datasource, timeframe: timeframeKey,
        limit: ASSET_LIMIT, startTime: from, endTime: end,
      });
      const list = Array.isArray(rows) ? rows : [];
      out.push(...list);
      const last = list[list.length - 1];
      if (list.length < ASSET_LIMIT || !last || last.time + tfMs >= end) break;
      from = last.time + tfMs;
    }
    return out;
  };

  // Pide sólo el tramo que falta (más la última vela, que puede seguir viva) y realinea.
  const loadOverlay = (overlay) => {
    const main = mainRef.current;
    if (!main?.length) return;
    const { timeframe: tf } = propsRef.current;
    const tfMs = OVERLAY_TF_MS[tf] ?? 60_000;
    const start = main[0].time;
    const end = main[main.length - 1].time + tfMs;
    const { id } = overlay;
    let cache = cacheRef.current.get(id);
    // Un tramo que no toca lo cacheado (salto a la vida de una opción o vuelta
    // al presente) empieza caché nueva: pedir el hueco entero no sirve.
    if (cache && cache.from !== null && (end < cache.from || start > cache.to)) {
      alignedRef.current.delete(id);
      cache = null;
      // Fuera los tiempos del tramo viejo: ensancharían el eje y moverían la vista.
      const entry = seriesRef.current.get(id);
      entry?.main.setData([]);
      entry?.untraded?.setData([]);
    }
    if (!cache) {
      cache = { candles: new Map(), from: null, to: null, loaded: false };
      cacheRef.current.set(id, cache);
    }
    const ranges = [];
    if (cache.from === null) {
      ranges.push([start, end]);
    } else {
      if (start < cache.from) ranges.push([start, cache.from]);
      const tailFrom = Math.max(cache.from, cache.to - tfMs);
      // Una opción vencida no cambia: si la caché ya cubre el vencimiento,
      // no se refresca la cola.
      const expiry = overlay.kind === 'option' ? overlay.option?.expiryMs : null;
      const frozen = Number.isFinite(expiry) && expiry < Date.now() && cache.loaded && cache.to > expiry;
      if (end > tailFrom && !frozen) ranges.push([tailFrom, Math.max(end, cache.to)]);
    }
    if (cache.from !== null) realign(id);
    if (!ranges.length) return;
    if (!alignedRef.current.get(id)?.some(hasValue)) setStatusFor(id, 'loading');
    cache.from = cache.from === null ? start : Math.min(cache.from, start);
    cache.to = cache.to === null ? end : Math.max(cache.to, end);
    const epoch = epochRef.current;
    const isCurrent = () => epochRef.current === epoch && cacheRef.current.get(id) === cache;
    for (const [s, e] of ranges) {
      fetchRange(overlay, tf, s, e).then((rows) => {
        if (!isCurrent()) return;
        for (const c of rows || []) if (c && Number.isFinite(c.time)) cache.candles.set(c.time, c);
        cache.loaded = true;
        realign(id);
      }).catch(() => {
        if (!isCurrent()) return;
        // Se descarta la cobertura para reintentar entera en el próximo syncMain.
        cacheRef.current.delete(id);
        setStatusFor(id, 'error');
      });
    }
  };

  const removeEntry = (chart, id) => {
    const entry = seriesRef.current.get(id);
    if (!entry) return;
    try { chart?.removeSeries(entry.main); } catch { /* chart ya destruido */ }
    if (entry.untraded) { try { chart?.removeSeries(entry.untraded); } catch { /* noop */ } }
    seriesRef.current.delete(id);
  };

  // Crea/actualiza/elimina series para que coincidan con el estado. Idempotente.
  const reconcile = () => {
    const chart = chartRef?.current;
    if (!chart) return;
    if (chartUsedRef.current !== chart) {
      seriesRef.current.clear();
      dimmedRef.current = null;
      signatureRef.current = null;
      chartUsedRef.current = chart;
    }
    const { candleColors: colors } = propsRef.current;
    const drawn = drawnOverlays();
    const { focusedId } = stateRef.current;
    const leftId = drawn.some((o) => o.id === focusedId) ? focusedId : drawn[0]?.id ?? null;
    // Nada que cambiar si las series dibujadas, colores y foco son los mismos.
    const signature = JSON.stringify([leftId, drawn.map((o) => [o.id, o.color]), colors]);
    if (signature === signatureRef.current) return;
    signatureRef.current = signature;
    const drawnIds = new Set(drawn.map((o) => o.id));
    for (const id of [...seriesRef.current.keys()]) {
      if (!drawnIds.has(id)) removeEntry(chart, id);
    }
    const created = [];
    for (const o of drawn) {
      const isLeft = o.id === leftId;
      const scaleId = isLeft ? 'left' : `ov-${o.id}`;
      const opts = {
        color: o.color,
        lineWidth: isLeft ? FOCUSED_WIDTH : OTHER_WIDTH,
        priceScaleId: scaleId,
        lastValueVisible: isLeft,
        priceLineVisible: false,
      };
      let entry = seriesRef.current.get(o.id);
      if (!entry) {
        const main = chart.addSeries(LineSeries, opts, 0);
        const untraded = o.kind === 'option'
          ? chart.addSeries(LineSeries, {
            color: UNTRADED_COLOR,
            lineStyle: LineStyle.Dashed,
            lineWidth: 2,
            priceScaleId: scaleId,
            lastValueVisible: false,
            priceLineVisible: false,
          }, 0)
          : null;
        entry = { kind: o.kind, main, untraded, scaleId, priceFormat: null };
        seriesRef.current.set(o.id, entry);
        created.push(o);
      } else {
        entry.main.applyOptions(opts);
        if (entry.untraded && entry.scaleId !== scaleId) entry.untraded.applyOptions({ priceScaleId: scaleId });
        entry.scaleId = scaleId;
      }
      if (!isLeft) chart.priceScale(scaleId).applyOptions({ visible: false, scaleMargins: OV_SCALE_MARGINS });
    }
    const focused = drawn.find((o) => o.id === leftId);
    chart.applyOptions({
      leftPriceScale: {
        visible: drawn.length > 0,
        borderColor: colors?.border ?? DEFAULT_BORDER,
        ...(focused ? { textColor: focused.color } : {}),
      },
    });
    const dim = drawn.length > 0;
    const candle = candleSeriesRef?.current;
    if (candle && colors && dimmedRef.current !== dim) {
      candle.applyOptions(candleOptions(colors, dim));
      dimmedRef.current = dim;
    }
    for (const o of created) {
      if (alignedRef.current.has(o.id)) applyData(o.id);
      loadOverlay(o);
    }
  };

  // Persistencia.
  useEffect(() => { saveOverlays(storage, state); }, [storage, state]);

  // Cambio de temporalidad: cachés y respuestas en vuelo dejan de valer.
  const firstTfRef = useRef(true);
  useEffect(() => {
    if (firstTfRef.current) { firstTfRef.current = false; return; }
    epochRef.current += 1;
    cacheRef.current.clear();
    alignedRef.current.clear();
    mainRef.current = null;
    for (const entry of seriesRef.current.values()) {
      entry.main.setData([]);
      entry.untraded?.setData([]);
    }
    setLoadStatus({});
  }, [timeframe]);

  useEffect(() => {
    reconcile();
  }); // barato e idempotente: tras cada render (estado, enabled, principal, colores)

  // Al desmontar: quita series y devuelve las velas a sus colores.
  useEffect(() => () => {
    const chart = chartUsedRef.current;
    for (const id of [...seriesRef.current.keys()]) removeEntry(chart, id);
    const { candleColors: colors } = propsRef.current;
    if (dimmedRef.current && colors) {
      try { candleSeriesRef?.current?.applyOptions(candleOptions(colors, false)); } catch { /* noop */ }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const syncMain = useCallback((mainCandles) => {
    mainRef.current = Array.isArray(mainCandles) && mainCandles.length ? mainCandles : null;
    reconcile();
    for (const o of drawnOverlays()) loadOverlay(o);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const valuesAt = useCallback((timeSec) => {
    return drawnOverlays().map((o) => {
      const points = alignedRef.current.get(o.id) || [];
      const i = indexAt(points, timeSec);
      const p = i >= 0 ? points[i] : null;
      const value = hasValue(p) ? p.value : null;
      const prev = i > 0 ? points[i - 1] : null;
      const changePct = value !== null && hasValue(prev) && prev.value !== 0
        ? ((value - prev.value) / prev.value) * 100
        : null;
      const traded = value !== null ? p.traded !== false : null;
      let lastTradeAgoH = null;
      if (o.kind === 'option' && traded === false) {
        for (let k = i - 1; k >= 0; k--) {
          if (hasValue(points[k]) && points[k].traded !== false) {
            lastTradeAgoH = (timeSec - points[k].time) / 3600;
            break;
          }
        }
      }
      return { id: o.id, label: shortLabel(o), color: o.color, value, changePct, traded, lastTradeAgoH };
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback(
    (fn, main) => setState((s) => ensureFocus(fn(s), main ?? propsRef.current.mainAsset)),
    [],
  );
  // Al cambiar el principal, el foco no puede quedarse en la que ahora lo es.
  const mainKey = mainAsset ? `${mainAsset.datasource}:${mainAsset.symbol}` : '';
  useEffect(() => { update((s) => s); }, [mainKey, update]);

  const forget = (id) => {
    cacheRef.current.delete(id);
    alignedRef.current.delete(id);
    setLoadStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };
  const add = useCallback((spec) => update((s) => addOverlay(s, spec)), [update]);
  const remove = useCallback((id) => {
    update((s) => removeOverlay(s, id));
    forget(id);
  }, [update]); // eslint-disable-line react-hooks/exhaustive-deps
  // `nextMain`: el principal que habrá tras un intercambio (aún no está en
  // props); sin él, el foco saltaría fuera del hueco intercambiado.
  const replace = useCallback((id, spec, nextMain) => {
    update((s) => replaceModel(s, id, spec), nextMain);
    forget(id);
  }, [update]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleHidden = useCallback((id) => update((s) => toggleHiddenModel(s, id)), [update]);
  const focus = useCallback((id) => update((s) => focusOverlay(s, id)), [update]);
  const setColor = useCallback((id, c) => update((s) => setColorModel(s, id, c)), [update]);

  const status = useMemo(() => {
    const out = {};
    for (const o of state.items) {
      if (isSameAsMain(o, mainAsset)) out[o.id] = 'isMain';
      else if (o.hidden || !enabled) out[o.id] = 'hidden';
      else out[o.id] = loadStatus[o.id] ?? 'loading';
    }
    return out;
  }, [state.items, mainAsset, enabled, loadStatus]);

  return { state, add, remove, replace, toggleHidden, focus, setColor, syncMain, valuesAt, status };
}

export default useChartOverlays;

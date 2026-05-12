import { useCallback, useEffect, useRef, useState } from 'react';
import { marketApi } from '../../../services/api';
import {
  alignToTimeframe,
  defaultLowerTimeframe,
  foldLtfIntoHtf,
  timeframeMs,
} from './replayUtils';

const HTF_BASE_LIMIT = 400;     // velas HTF "frozen" antes del anchor
const LTF_FETCH_LIMIT = 500;    // tamaño de cada fetch de buffer LTF
const LTF_PREFETCH_AT = 100;    // umbral: si quedan menos, prefetch más
const BASE_TICK_MS = 1000;      // 1× = 1 sub-vela/s

// Hook que orquesta el modo replay sobre el gráfico actual.
//
// Mantiene su propio estado (active/paused/speed/...) y mutaciones sobre
// `candlesRef.current` para que la página principal siga reutilizando sus
// indicadores y scroll sin saber del replay. Al detener, restaura desde un
// snapshot y notifica al padre vía `onStopped` para que refresque datos vivos.
export function useReplayController({
  asset,
  timeframe,            // HTF mostrada
  candleSeriesRef,
  candlesRef,
  indicatorsControllerRef,
  indicatorsRef,
  chartRef,
  onError,
  onStopped,
  onTick,               // (htfInProgress) => void: notifica al padre cada tick
}) {
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(true);
  const [speed, setSpeed] = useState(2);                         // multiplicador
  const [subTf, setSubTf] = useState(() => defaultLowerTimeframe(timeframe));
  const [anchor, setAnchor] = useState(null);                    // ms
  const [progress, setProgress] = useState({ ltfTime: null, htfBucket: null });
  const [loading, setLoading] = useState(false);

  // Refs para acceder al estado dentro del tick loop sin depender del closure.
  const ltfBufferRef = useRef([]);
  const ltfCursorRef = useRef(0);
  const htfInProgressRef = useRef(null);
  const baseSnapshotRef = useRef(null);                          // snapshot HTF original
  const tickTimerRef = useRef(null);
  const pausedRef = useRef(true);
  const speedRef = useRef(2);
  const subTfRef = useRef(subTf);
  const fetchingMoreRef = useRef(false);
  const sessionRef = useRef(0);                                  // id de sesión para cancelar fetches viejos

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { subTfRef.current = subTf; }, [subTf]);

  const computeTickInterval = () => Math.max(50, Math.round(BASE_TICK_MS / speedRef.current));

  // -- Prefetch (declarado antes de doTick porque doTick lo invoca) --
  const prefetchMoreLtf = useCallback(async () => {
    if (fetchingMoreRef.current) return;
    const buf = ltfBufferRef.current;
    if (buf.length === 0) return;
    const lastTime = buf[buf.length - 1].time;
    const sessionAtFetch = sessionRef.current;
    fetchingMoreRef.current = true;
    try {
      const more = await marketApi.getCandles({
        asset: asset.symbol,
        datasource: asset.datasource || 'hyperliquid',
        timeframe: subTfRef.current,
        limit: LTF_FETCH_LIMIT,
        startTime: lastTime + 1,
      });
      if (sessionAtFetch !== sessionRef.current) return;
      if (Array.isArray(more) && more.length > 0) {
        ltfBufferRef.current = ltfBufferRef.current.concat(more);
      }
    } catch (err) {
      onError?.(`Replay: error obteniendo sub-velas: ${err.message}`);
    } finally {
      fetchingMoreRef.current = false;
    }
  }, [asset, onError]);

  // -- Tick: avanza una sub-vela y actualiza chart + indicadores --
  const doTick = useCallback(() => {
    const buf = ltfBufferRef.current;
    const cursor = ltfCursorRef.current;
    if (cursor >= buf.length) {
      prefetchMoreLtf();
      return;
    }

    const ltf = buf[cursor];
    ltfCursorRef.current = cursor + 1;

    const prevHtf = htfInProgressRef.current;
    const updatedHtf = foldLtfIntoHtf(ltf, prevHtf, timeframe);
    htfInProgressRef.current = updatedHtf;

    // Mutación en sitio del array, igual que el live polling.
    const arr = candlesRef.current;
    const last = arr[arr.length - 1];
    if (last && last.time === updatedHtf.time) {
      arr[arr.length - 1] = { ...updatedHtf };
    } else {
      arr.push({ ...updatedHtf });
    }

    candleSeriesRef.current?.update({
      time: Math.floor(updatedHtf.time / 1000),
      open: updatedHtf.open,
      high: updatedHtf.high,
      low: updatedHtf.low,
      close: updatedHtf.close,
    });

    indicatorsControllerRef.current?.render(indicatorsRef.current, arr);

    setProgress({ ltfTime: ltf.time, htfBucket: updatedHtf.time });
    onTick?.(updatedHtf);

    if (buf.length - ltfCursorRef.current < LTF_PREFETCH_AT) {
      prefetchMoreLtf();
    }
  }, [candlesRef, candleSeriesRef, indicatorsControllerRef, indicatorsRef, prefetchMoreLtf, timeframe, onTick]);

  const restartTimer = useCallback(() => {
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (!pausedRef.current) {
      tickTimerRef.current = setInterval(() => doTick(), computeTickInterval());
    }
  }, [doTick]);

  // Reinicia el timer cuando cambia la velocidad y estamos reproduciendo.
  useEffect(() => {
    if (active && !paused) restartTimer();
  }, [speed, active, paused, restartTimer]);

  // -- Stop / Start --
  const stop = useCallback(({ silent } = {}) => {
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    sessionRef.current += 1;
    ltfBufferRef.current = [];
    ltfCursorRef.current = 0;
    htfInProgressRef.current = null;
    fetchingMoreRef.current = false;
    setActive(false);
    setPaused(true);
    setProgress({ ltfTime: null, htfBucket: null });

    if (!silent) {
      if (baseSnapshotRef.current && candlesRef.current) {
        candlesRef.current.length = 0;
        for (const c of baseSnapshotRef.current) candlesRef.current.push(c);
        const data = baseSnapshotRef.current.map((c) => ({
          time: Math.floor(c.time / 1000),
          open: c.open, high: c.high, low: c.low, close: c.close,
        }));
        candleSeriesRef.current?.setData(data);
        indicatorsControllerRef.current?.render(indicatorsRef.current, baseSnapshotRef.current);
      }
      onStopped?.();
    }
    baseSnapshotRef.current = null;
  }, [candlesRef, candleSeriesRef, indicatorsControllerRef, indicatorsRef, onStopped]);

  const start = useCallback(async ({ anchor: anchorMs, subTf: chosenSubTf }) => {
    if (!asset?.symbol || !chosenSubTf) {
      onError?.('Replay: selecciona una sub-temporalidad válida.');
      return;
    }
    const bucketStart = alignToTimeframe(anchorMs, timeframe);
    const session = ++sessionRef.current;
    setLoading(true);
    setSubTf(chosenSubTf);

    try {
      const [htfBase, ltfChunk] = await Promise.all([
        marketApi.getCandles({
          asset: asset.symbol,
          datasource: asset.datasource || 'hyperliquid',
          timeframe,
          limit: HTF_BASE_LIMIT,
          endTime: bucketStart - 1,
        }),
        marketApi.getCandles({
          asset: asset.symbol,
          datasource: asset.datasource || 'hyperliquid',
          timeframe: chosenSubTf,
          limit: LTF_FETCH_LIMIT,
          startTime: bucketStart,
        }),
      ]);
      if (session !== sessionRef.current) return;

      if (!Array.isArray(htfBase) || htfBase.length === 0) {
        onError?.('Replay: no se recibió histórico para esa fecha.');
        setLoading(false);
        return;
      }
      if (!Array.isArray(ltfChunk) || ltfChunk.length === 0) {
        onError?.('Replay: no hay sub-velas disponibles desde el anchor.');
        setLoading(false);
        return;
      }

      baseSnapshotRef.current = candlesRef.current.slice();

      candlesRef.current.length = 0;
      for (const c of htfBase) candlesRef.current.push(c);

      const baseData = htfBase.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
      }));
      candleSeriesRef.current?.setData(baseData);
      indicatorsControllerRef.current?.render(indicatorsRef.current, candlesRef.current);

      ltfBufferRef.current = ltfChunk;
      ltfCursorRef.current = 0;
      htfInProgressRef.current = null;

      try {
        const bucketSec = Math.floor(bucketStart / 1000);
        const tfSec = timeframeMs(timeframe) / 1000;
        const before = Math.max(20, Math.floor(htfBase.length * 0.9));
        chartRef.current?.timeScale().setVisibleRange({
          from: bucketSec - before * tfSec,
          to: bucketSec + tfSec * 8,
        });
      } catch { /* noop */ }

      setAnchor(anchorMs);
      setActive(true);
      setPaused(true);
      setProgress({ ltfTime: null, htfBucket: bucketStart });
    } catch (err) {
      onError?.(`Replay: ${err.message}`);
      sessionRef.current += 1;
    } finally {
      setLoading(false);
    }
  }, [asset, timeframe, candlesRef, candleSeriesRef, indicatorsControllerRef, indicatorsRef, chartRef, onError]);

  const play = useCallback(() => {
    if (!active) return;
    setPaused(false);
    pausedRef.current = false;
    restartTimer();
  }, [active, restartTimer]);

  const pause = useCallback(() => {
    setPaused(true);
    pausedRef.current = true;
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  const step = useCallback(() => {
    if (!active) return;
    pause();
    doTick();
  }, [active, doTick, pause]);

  const reset = useCallback(() => {
    if (!active || anchor == null) return;
    const a = anchor;
    const s = subTf;
    stop({ silent: true });
    start({ anchor: a, subTf: s });
  }, [active, anchor, subTf, start, stop]);

  // Si cambia la HTF mostrada, resetea sub-TF default y aborta replay.
  // Nota: `active` y `stop` se omiten de deps a propósito — sólo queremos
  // disparar este efecto cuando cambia la HTF, no cuando se inicia replay.
  useEffect(() => {
    setSubTf(defaultLowerTimeframe(timeframe));
    if (active) stop({ silent: true });
  }, [timeframe]);

  // Si cambia asset, aborta replay (mismo motivo que arriba).
  useEffect(() => {
    if (active) stop({ silent: true });
  }, [asset?.symbol, asset?.datasource]);

  // Cleanup al desmontar.
  useEffect(() => () => {
    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    sessionRef.current += 1;
  }, []);

  return {
    active,
    paused,
    loading,
    speed,
    subTf,
    anchor,
    progress,
    setSpeed,
    setSubTf,
    start,
    stop,
    play,
    pause,
    step,
    reset,
  };
}

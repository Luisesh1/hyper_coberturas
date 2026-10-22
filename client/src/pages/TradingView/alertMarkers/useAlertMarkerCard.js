import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const timeOf = (param) => (typeof param?.time === 'number' ? param.time : null);

// Estado de la tarjeta de detalle de las marcas de alertas.
// Escritorio: pasar por una vela con disparos la muestra (todos los de la vela);
//   un clic la fija; clic fuera, clic en una vela sin disparos o Esc la cierran.
// Móvil: tocar una vela abre su primer disparo en una hoja; ‹ › recorren los
//   disparos dibujados de esa misma alerta en orden temporal y desplazan el
//   gráfico si hace falta.
// `timeline` = markerTimeline(...): [{ alertId, event, sec }] ordenado.
// `ignoreSynthetic`: descarta movimientos con posición pero sin `sourceEvent`
// (setCrosshairPosition del puntero sincronizado en la vista Multi‑TF).
export function useAlertMarkerCard({ chartRef, mobile, timeline, disabled = false, ignoreSynthetic = false }) {
  const [desk, setDesk] = useState(null); // { sec, anchor, pinned }
  const [sel, setSel] = useState(null); // móvil: { alertId, evalTime }
  const cardRef = useRef(null);

  const byBucket = useMemo(() => {
    const m = new Map();
    for (const en of timeline || []) {
      if (!m.has(en.sec)) m.set(en.sec, []);
      m.get(en.sec).push(en);
    }
    return m;
  }, [timeline]);

  const byBucketRef = useRef(byBucket);
  byBucketRef.current = byBucket;
  const pinnedRef = useRef(false);
  pinnedRef.current = !!desk?.pinned;

  const close = useCallback(() => { setDesk(null); setSel(null); }, []);

  useEffect(() => { if (disabled) close(); }, [disabled, close]);
  useEffect(() => { close(); }, [mobile, close]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || disabled) return undefined;
    const onMove = (param) => {
      if (mobile || pinnedRef.current) return;
      if (ignoreSynthetic && param?.point && !param.sourceEvent) return;
      const sec = timeOf(param);
      if (sec == null || !param.point || !byBucketRef.current.has(sec)) {
        setDesk((prev) => (prev ? null : prev));
        return;
      }
      const anchor = { x: param.point.x, y: param.point.y };
      setDesk((prev) => (prev && prev.sec === sec ? prev : { sec, anchor, pinned: false }));
    };
    const onClick = (param) => {
      const sec = timeOf(param);
      const entries = sec != null ? byBucketRef.current.get(sec) : null;
      if (mobile) {
        if (entries) setSel({ alertId: entries[0].alertId, evalTime: entries[0].event.evalTime });
        return;
      }
      if (entries && param.point) setDesk({ sec, anchor: { x: param.point.x, y: param.point.y }, pinned: true });
      else setDesk(null);
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
    };
  }, [chartRef, mobile, disabled, ignoreSynthetic]);

  // Fijada en escritorio: Esc o un clic fuera de la tarjeta y del gráfico la cierran.
  const pinned = !mobile && !!desk?.pinned;
  useEffect(() => {
    if (!pinned) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDesk(null); };
    const onDown = (e) => {
      if (cardRef.current?.contains(e.target)) return;
      if (chartRef.current?.chartElement?.()?.contains(e.target)) return; // lo resuelve subscribeClick
      setDesk(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [pinned, chartRef]);

  // Móvil: disparos de la alerta elegida (timeline ya viene en orden temporal).
  const selAlertId = sel?.alertId ?? null;
  const mobileEntries = useMemo(
    () => (selAlertId == null ? [] : (timeline || []).filter((en) => en.alertId === selAlertId)),
    [selAlertId, timeline],
  );
  const mobileIndex = sel ? mobileEntries.findIndex((en) => en.event.evalTime === sel.evalTime) : -1;

  const goTo = useCallback((idx) => {
    const en = mobileEntries[idx];
    if (!en) return;
    setSel({ alertId: en.alertId, evalTime: en.event.evalTime });
    try {
      const ts = chartRef.current?.timeScale();
      const range = ts?.getVisibleRange();
      if (range && (en.sec < range.from || en.sec > range.to)) {
        const half = (range.to - range.from) / 2;
        ts.setVisibleRange({ from: en.sec - half, to: en.sec + half });
      }
    } catch { /* gráfico sin datos */ }
  }, [mobileEntries, chartRef]);

  let card = null;
  if (mobile && mobileIndex >= 0) {
    card = {
      entries: mobileEntries,
      index: mobileIndex,
      onPrev: () => goTo(mobileIndex - 1),
      onNext: () => goTo(mobileIndex + 1),
      onClose: close,
    };
  } else if (!mobile && desk && byBucket.has(desk.sec)) {
    card = { entries: byBucket.get(desk.sec), index: undefined, anchor: desk.anchor, onClose: close };
  }

  // Sin fijar, la tarjeta no captura el ratón (si no, tapa el crosshair y parpadea).
  return { card, cardRef, pinned: !mobile && !!card && !!desk?.pinned };
}

export default useAlertMarkerCard;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alertsApi } from '../../../services/api';
import { ERROR_BACKOFF_MS, OVERLAY_TF_MS } from '../overlays/useChartOverlays.js';

export const MAX_EVALS_PER_REQUEST = 2000;
export const MAX_CHUNKS_PER_ALERT = 10;

const ruleConditions = (rule) => {
  if (Array.isArray(rule?.conditions)) return rule.conditions;
  if (rule?.indicatorType) return [rule];
  return [];
};

// Temporalidad más baja entre las condiciones (y operandos de serie) de la alerta.
export function clientBaseTfMs(alert) {
  let lowest = Infinity;
  for (const r of alert?.rules || []) {
    for (const c of ruleConditions(r)) {
      const tfs = [c.timeframe];
      if (c.operand?.kind === 'series') tfs.push(c.operand.timeframe);
      for (const tf of tfs) {
        const ms = OVERLAY_TF_MS[tf];
        if (ms && ms < lowest) lowest = ms;
      }
    }
  }
  return Number.isFinite(lowest) ? lowest : OVERLAY_TF_MS['1m'];
}

// Primer tramo sin cubrir yendo del borde derecho hacia atrás: [start, end] o null.
function newestGap(covered, from, to) {
  let pos = to;
  const desc = [...covered].sort((a, b) => b[1] - a[1]);
  for (const [s, e] of desc) {
    if (pos <= from) return null;
    if (s >= pos) continue;
    if (e >= pos) { pos = s; continue; }
    return [Math.max(e, from), pos];
  }
  return pos > from ? [from, pos] : null;
}

// Hasta dónde llega hacia atrás la zona contigua cubierta que termina en `to`.
function coveredBackTo(covered, to) {
  let pos = to;
  const desc = [...covered].sort((a, b) => b[1] - a[1]);
  for (const [s, e] of desc) {
    if (s >= pos) continue;
    if (e >= pos) pos = s; else break;
  }
  return pos;
}

function addCovered(covered, s, e) {
  const all = [...covered, [s, e]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of all) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export function useAlertBacktest({ asset, items, alertsById, ranges, enabled = true }) {
  const [out, setOut] = useState({ events: {}, status: {} });
  const cachesRef = useRef(new Map()); // `${id}:${updatedAt}:${ds}:${symbol}` -> cache
  const edgesRef = useRef(new Map()); // `${id}:${ds}:${symbol}` -> borde derecho fijo
  const runningRef = useRef(new Set());
  const aliveRef = useRef(true);

  const fromMs = ranges?.length ? Math.min(...ranges.map((r) => r.fromMs)) : null;
  const toMs = ranges?.length ? Math.max(...ranges.map((r) => r.toMs)) : null;

  const propsRef = useRef({});
  propsRef.current = { asset, items, alertsById, fromMs, toMs, enabled };

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const keyOf = (alertId) => {
    const { asset: a, alertsById: byId } = propsRef.current;
    const alert = byId?.[alertId];
    if (!alert || !a) return null;
    return `${alertId}:${alert.updatedAt}:${a.datasource}:${a.symbol}`;
  };

  const publish = (alertId, key, events, status) => {
    if (!aliveRef.current) return;
    setOut((prev) => ({
      events: events ? { ...prev.events, [alertId]: { key, list: events } } : prev.events,
      status: { ...prev.status, [alertId]: { key, st: status } },
    }));
  };

  const snapshot = (alertId, cache, state, extra = {}) => {
    const { asset: a, alertsById: byId, fromMs: f } = propsRef.current;
    const alert = byId?.[alertId];
    const st = { state, ...extra };
    if (cache.insufficient) st.insufficient = cache.insufficient;
    if (cache.approx) st.approx = true;
    if (alert && a && alert.datasource !== a.datasource) st.sourceMismatch = alert.datasource;
    if (cache.capped && cache.edge != null && f != null) {
      const back = coveredBackTo(cache.covered, cache.edge);
      if (back > f) st.partialFromMs = back;
    }
    return st;
  };

  const eventList = (cache) => [...cache.events.values()].sort((x, y) => x.evalTime - y.evalTime);

  const run = async (alertId) => {
    const key0 = keyOf(alertId);
    if (!key0 || runningRef.current.has(key0)) return;
    const cache = cachesRef.current.get(key0);
    runningRef.current.add(key0);
    try {
      for (;;) {
        // Todo se relee en cada vuelta: las props pueden haber cambiado durante la petición.
        if (keyOf(alertId) !== key0) return;
        const { asset: a, alertsById: byId, fromMs: f, enabled: en } = propsRef.current;
        const alert = byId[alertId];
        if (!en || f == null || cache.errorUntil > Date.now()) return;
        if (cache.edge == null) {
          const ek = `${alertId}:${a.datasource}:${a.symbol}`;
          if (!edgesRef.current.has(ek)) edgesRef.current.set(ek, propsRef.current.toMs);
          cache.edge = edgesRef.current.get(ek);
        }
        const gap = newestGap(cache.covered, f, cache.edge);
        if (!gap) { cache.capped = false; publish(alertId, key0, eventList(cache), snapshot(alertId, cache, 'ready')); return; }
        if (cache.chunks >= MAX_CHUNKS_PER_ALERT) {
          cache.capped = true;
          publish(alertId, key0, eventList(cache), snapshot(alertId, cache, 'ready'));
          return;
        }
        const baseMs = cache.baseMs || clientBaseTfMs(alert);
        const s = Math.max(gap[0], gap[1] - MAX_EVALS_PER_REQUEST * baseMs);
        const e = gap[1];
        cache.chunks += 1;
        publish(alertId, key0, null, snapshot(alertId, cache, 'loading'));
        let res;
        try {
          res = await alertsApi.backtest(alertId, {
            asset: a.symbol, datasource: a.datasource, startTime: s, endTime: e,
          });
        } catch (err) {
          cache.chunks -= 1;
          cache.errorUntil = Date.now() + ERROR_BACKOFF_MS;
          if (keyOf(alertId) === key0) {
            publish(alertId, key0, null, snapshot(alertId, cache, 'error', { error: err?.message || 'error' }));
          }
          return;
        }
        if (OVERLAY_TF_MS[res?.baseTimeframe]) cache.baseMs = OVERLAY_TF_MS[res.baseTimeframe];
        for (const ev of res?.events || []) cache.events.set(ev.evalTime, ev);
        cache.insufficient += Number(res?.insufficient) || 0;
        if (res?.cooldownApprox) cache.approx = true;
        cache.covered = addCovered(cache.covered, s, e);
      }
    } finally {
      runningRef.current.delete(key0);
    }
  };

  // Dispara las cargas necesarias cuando cambian activo, selección, alertas o el rango "hacia atrás".
  // El borde derecho (toMs) queda fijo tras la primera petición, así que crecer toMs no pide nada.
  const assetKey = asset ? `${asset.datasource}:${asset.symbol}` : '';
  useEffect(() => {
    if (!enabled || !asset) return;
    const statuses = {};
    for (const item of items || []) {
      const alert = alertsById?.[item.alertId];
      if (!alert) { statuses[item.alertId] = { state: 'deleted' }; continue; }
      if (item.hidden) continue;
      const key = keyOf(item.alertId);
      let cache = cachesRef.current.get(key);
      if (!cache) {
        cache = { covered: [], events: new Map(), chunks: 0, baseMs: null, insufficient: 0, approx: false, errorUntil: 0, edge: null, capped: false };
        cachesRef.current.set(key, cache);
      }
      if (cache.errorUntil > Date.now()) {
        statuses[item.alertId] = snapshot(item.alertId, cache, 'error', { error: 'error' });
      } else {
        statuses[item.alertId] = snapshot(item.alertId, cache, cache.covered.length ? 'ready' : 'loading');
        run(item.alertId);
      }
    }
    setOut((prev) => {
      const status = { ...prev.status };
      for (const [id, st] of Object.entries(statuses)) status[id] = { key: st.state === 'deleted' ? null : keyOf(id), st };
      return { events: prev.events, status };
    });
  }, [enabled, assetKey, items, alertsById, fromMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback((alertId) => {
    const key = keyOf(alertId);
    const cache = key && cachesRef.current.get(key);
    if (!cache) return;
    cache.errorUntil = 0;
    run(alertId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sólo se exponen las alertas elegidas del activo actual.
  const view = useMemo(() => {
    const events = {};
    const status = {};
    for (const item of items || []) {
      const alert = alertsById?.[item.alertId];
      if (!alert) { status[item.alertId] = { state: 'deleted' }; continue; }
      const key = asset ? `${item.alertId}:${alert.updatedAt}:${asset.datasource}:${asset.symbol}` : null;
      const cache = key && cachesRef.current.get(key);
      const ev = out.events[item.alertId];
      if (cache && ev?.key === key) events[item.alertId] = ev.list;
      const st = out.status[item.alertId];
      if (st?.key === key) status[item.alertId] = st.st;
    }
    return { events, status };
  }, [out, items, alertsById, asset]); // eslint-disable-line react-hooks/exhaustive-deps

  return { eventsByAlert: view.events, statusByAlert: view.status, retry };
}

export default useAlertBacktest;

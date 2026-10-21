// Modelo de superposiciones del gráfico principal. Lógica pura (el storage se
// inyecta) para poder testearla sin DOM.
export const OVERLAY_PALETTE = ['#f59e0b', '#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#93c5fd'];
export const MAX_OVERLAYS = 6;
export const OVERLAYS_STORAGE_KEY = 'tv_overlays_v1';

const EMPTY_STATE = { items: [], focusedId: null };
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function overlayId(spec) {
  return spec.kind === 'option'
    ? `option:${spec.option.instrument}`
    : `asset:${spec.asset.datasource}:${spec.asset.symbol}`;
}

function firstVisibleId(items) {
  return items.find((o) => !o.hidden)?.id ?? null;
}

// Primer color de la paleta que no usa ninguna superposición.
function freeColor(items) {
  const used = new Set(items.map((o) => o.color));
  return OVERLAY_PALETTE.find((c) => !used.has(c)) ?? OVERLAY_PALETTE[items.length % OVERLAY_PALETTE.length];
}

export function addOverlay(state, spec) {
  const id = overlayId(spec);
  if (state.items.some((o) => o.id === id) || state.items.length >= MAX_OVERLAYS) return state;
  const item = { id, kind: spec.kind, color: freeColor(state.items), hidden: false };
  if (spec.kind === 'option') item.option = spec.option; else item.asset = spec.asset;
  return { items: [...state.items, item], focusedId: state.focusedId ?? id };
}

export function removeOverlay(state, id) {
  if (!state.items.some((o) => o.id === id)) return state;
  const items = state.items.filter((o) => o.id !== id);
  const focusedId = state.focusedId === id ? firstVisibleId(items) : state.focusedId;
  return { items, focusedId };
}

// Sustituye una superposición por otra en el mismo hueco y con el mismo color
// (intercambio con el principal). Si la nueva ya estaba en la lista, se quita
// esa entrada para no duplicarla. El foco sigue al hueco.
export function replaceOverlay(state, id, spec) {
  const old = state.items.find((o) => o.id === id);
  if (!old) return state;
  const newId = overlayId(spec);
  const item = { id: newId, kind: spec.kind, color: old.color, hidden: false };
  if (spec.kind === 'option') item.option = spec.option; else item.asset = spec.asset;
  const items = state.items
    .filter((o) => o.id === id || o.id !== newId)
    .map((o) => (o.id === id ? item : o));
  const focusedId = state.focusedId === id || state.focusedId === newId ? newId : state.focusedId;
  return { items, focusedId };
}

function mapItem(state, id, fn) {
  if (!state.items.some((o) => o.id === id)) return state;
  return { ...state, items: state.items.map((o) => (o.id === id ? fn(o) : o)) };
}

export const toggleHidden = (state, id) => mapItem(state, id, (o) => ({ ...o, hidden: !o.hidden }));
export const setColor = (state, id, color) => mapItem(state, id, (o) => ({ ...o, color }));
export function focusOverlay(state, id) {
  if (state.focusedId === id || !state.items.some((o) => o.id === id)) return state;
  return { ...state, focusedId: id };
}

// Valida una entrada guardada; devuelve null si no sirve.
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  if (raw.kind === 'asset') {
    const a = raw.asset;
    if (!a || typeof a.symbol !== 'string' || typeof a.datasource !== 'string') return null;
    return { id: raw.id, kind: 'asset', color: raw.color, hidden: !!raw.hidden, asset: { symbol: a.symbol, datasource: a.datasource, name: a.name ?? a.symbol } };
  }
  if (raw.kind === 'option') {
    const o = raw.option;
    if (!o || typeof o.instrument !== 'string') return null;
    return { id: raw.id, kind: 'option', color: raw.color, hidden: !!raw.hidden, option: o };
  }
  return null;
}

export function loadOverlays(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(OVERLAYS_STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return EMPTY_STATE;
    const seen = new Set();
    const items = [];
    for (const r of parsed.items) {
      const it = sanitize(r);
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      if (items.length >= MAX_OVERLAYS) break;
      items.push(it);
    }
    // Colores inválidos o repetidos se reasignan al primer libre.
    const kept = new Set();
    for (const it of items) {
      if (OVERLAY_PALETTE.includes(it.color) && !kept.has(it.color)) kept.add(it.color); else it.color = null;
    }
    const fixed = [];
    for (const it of items) {
      const color = it.color ?? OVERLAY_PALETTE.find((c) => !kept.has(c));
      kept.add(color);
      fixed.push({ ...it, color });
    }
    const focusedId = fixed.some((o) => o.id === parsed.focusedId) ? parsed.focusedId : firstVisibleId(fixed);
    return { items: fixed, focusedId };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveOverlays(storage = globalThis.localStorage, state) {
  try { storage?.setItem(OVERLAYS_STORAGE_KEY, JSON.stringify(state)); } catch { /* noop */ }
}

export function isSameAsMain(overlay, mainAsset) {
  if (overlay?.kind !== 'asset' || !mainAsset) return false;
  return overlay.asset.datasource === mainAsset.datasource
    && String(overlay.asset.symbol).toUpperCase() === String(mainAsset.symbol).toUpperCase();
}

// Una entrada por vela del principal (time en s). Toma la vela del superpuesto
// cuya apertura cae en [main.time, main.time + tfMs); si hay varias, la última.
// Sin vela → hueco `{ time }`. Las velas sin `traded` (activos) cuentan como negociadas.
export function alignToMain(mainCandles, overlayCandles, tfMs) {
  const sorted = [...overlayCandles].sort((a, b) => a.time - b.time);
  const points = [];
  let j = 0;
  for (const m of mainCandles) {
    const end = m.time + tfMs;
    while (j < sorted.length && sorted[j].time < m.time) j++;
    let pick = null;
    let k = j;
    while (k < sorted.length && sorted[k].time < end) { pick = sorted[k]; k++; }
    const time = m.time / 1000;
    points.push(pick ? { time, value: pick.close, traded: pick.traded !== false } : { time });
  }
  return points;
}

// Un segmento (i-1 → i) es no negociado si y solo si el punto i lo es. Cada
// lista va alineada en tiempo y lleva huecos donde dibuja la otra.
export function splitTraded(points) {
  const has = (p) => p && 'value' in p && p.value !== undefined;
  const isU = (p) => p.traded === false;
  const traded = [];
  const untraded = [];
  points.forEach((p, i) => {
    if (!has(p)) { traded.push({ time: p.time }); untraded.push({ time: p.time }); return; }
    const prev = points[i - 1];
    const next = points[i + 1];
    const tSeg = (has(prev) && !isU(p)) || (has(next) && !isU(next));
    const uSeg = (has(prev) && isU(p)) || (has(next) && isU(next));
    const alone = !has(prev) && !has(next);
    const inTraded = tSeg || (alone && !isU(p));
    const inUntraded = uSeg || (alone && isU(p));
    traded.push(inTraded ? p : { time: p.time });
    untraded.push(inUntraded ? p : { time: p.time });
  });
  return { traded, untraded };
}

export function shortLabel(overlay) {
  if (overlay.kind === 'option') {
    const o = overlay.option;
    const d = new Date(o.expiryMs);
    return `${o.underlying} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${o.type} ${o.strike}`;
  }
  const s = overlay.asset.symbol ?? overlay.asset.name ?? '';
  const m = /^(.+)(USDT|USDC)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : s;
}

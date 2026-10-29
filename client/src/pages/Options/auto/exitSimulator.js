// Presentación del simulador de salidas: filas de «Mejores combinaciones»,
// mapa TP × tiempo máximo y celda más cercana a la configuración del bot.
// Los datos vienen de GET /options/auto-bots/:id/exit-simulation.
import { formatNumber, formatUsdt, toNumber } from '../strategies/common/format';

export const SMALL_SAMPLE = 20;
export const SMALL_SAMPLE_TEXT = 'Muestra pequeña: úsalo para descartar ideas, no para afinar números.';
// El servidor solo simula las posiciones cerradas más recientes (`truncated`).
export const TRUNCATED_TEXT = 'Solo las últimas 1000 operaciones';
export const STOP_OPTIONS = [
  { value: null, label: 'sin' },
  { value: 30, label: '30 %' },
  { value: 50, label: '50 %' },
];

const usdt = (v) => `${formatUsdt(v, { sign: true })} USDT`;

export const tpText = (tp) => (tp === null || tp === undefined ? 'Sin TP' : `+${formatNumber(tp, { decimals: 0 })} %`);
export const stopText = (s) => (s === null || s === undefined ? 'sin' : `−${formatNumber(s, { decimals: 0 })} %`);
export const holdText = (h) => (h === null || h === undefined ? 'sin' : `${formatNumber(h, { decimals: 0 })} h`);

export function avgHoldText(minutes) {
  const m = toNumber(minutes);
  if (m === null) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h >= 48 ? `${formatNumber(h / 24, { decimals: 1 })} d` : `${formatNumber(h, { decimals: 1 })} h`;
}

export function coverageText(c) {
  if (!c) return '';
  return `${c.positions} operaciones · ${c.minute} con datos por minuto · ${c.hourly} solo horarios · ${c.none} sin datos`;
}

// Referencia de la cabecera: lo real sobre las posiciones con datos (las que
// entran en los escenarios). El total solo se añade si difiere.
export function actualModel(data) {
  const covered = data?.actualCovered || data?.actual || { pnlUsdt: 0, trades: 0 };
  const total = data?.actual;
  const differs = !!total && !!data?.actualCovered
    && (Number(total.pnlUsdt) !== Number(covered.pnlUsdt) || Number(total.trades) !== Number(covered.trades));
  return {
    trades: Number(covered.trades) || 0,
    main: `Real con datos: ${formatUsdt(covered.pnlUsdt ?? 0)} USDT · ${covered.trades ?? 0} operaciones`,
    secondary: differs ? `Real total: ${formatUsdt(total.pnlUsdt ?? 0)} USDT (${total.trades})` : null,
  };
}

// Diferencia contra lo real de las mismas posiciones que usó el escenario.
export function vsReal(s) {
  const a = toNumber(s?.actualPnlUsdt);
  const p = toNumber(s?.pnlUsdt);
  if (a === null || p === null) return { text: '—', value: null };
  const d = Math.round((p - a) * 100) / 100;
  return { text: `${formatUsdt(d, { sign: true })} USDT`, value: d };
}

export function bestRows(data) {
  return (data?.best || []).map((s, i) => ({
    key: `${i}-${s.tpPct}-${s.maxHoldHours}-${s.stopPct}`,
    tp: tpText(s.tpPct),
    hold: holdText(s.maxHoldHours),
    stop: stopText(s.stopPct),
    pnl: usdt(s.pnlUsdt),
    pnlValue: s.pnlUsdt,
    vs: vsReal(s).text,
    vsValue: vsReal(s).value,
    hits: `${s.wins}/${s.trades}`,
    avgHold: avgHoldText(s.avgHoldMinutes),
    incomplete: Number(s.incomplete) > 0,
  }));
}

const sortedUnique = (list) => [...new Set(list)];
const byNullLast = (a, b) => (a === null ? 1 : b === null ? -1 : a - b);

// Mapa para un stop: filas TP, columnas tiempo máx. y celdas coloreadas por P&L.
export function buildGrid(scenarios, stopPct) {
  const list = (scenarios || []).filter((s) => (s.stopPct ?? null) === stopPct);
  const tps = sortedUnique(list.map((s) => s.tpPct ?? null)).sort(byNullLast);
  const holds = sortedUnique(list.map((s) => s.maxHoldHours ?? null)).sort(byNullLast);
  // Escala global (todos los stops) para que los colores sean comparables.
  const max = (scenarios || []).reduce((m, s) => Math.max(m, Math.abs(Number(s.pnlUsdt) || 0)), 0);
  const find = (tp, h) => list.find((s) => (s.tpPct ?? null) === tp && (s.maxHoldHours ?? null) === h);
  const rows = tps.map((tp) => ({
    tp,
    cells: holds.map((h) => {
      const s = find(tp, h);
      const p = s ? Number(s.pnlUsdt) : null;
      return {
        hold: h,
        pnl: p,
        text: p === null || !Number.isFinite(p) ? '—' : formatNumber(p, { decimals: 0, sign: true }),
        detail: s ? `TP ${tpText(tp)} · tiempo ${holdText(h)}: ${usdt(p)} · acierto ${s.wins}/${s.trades} · vs real ${vsReal(s).text}` : '',
        title: s ? `TP ${tpText(tp)} · tiempo ${holdText(h)}: ${usdt(p)} · acierto ${s.wins}/${s.trades} · vs real ${vsReal(s).text}` : '',
        tp,
        // Intensidad proporcional al mayor |P&L| del mapa.
        intensity: max > 0 && p ? Math.min(1, Math.abs(p) / max) : 0,
        sign: p > 0 ? 'pos' : p < 0 ? 'neg' : 'zero',
      };
    }),
  }));
  return { tps, holds, rows };
}

const nearest = (values, target) => values.reduce((best, v) => (
  best === null || Math.abs(v - target) < Math.abs(best - target) ? v : best), null);

// Celda más cercana a la configuración del bot, solo con TP fijo (con banda
// ATR o volatilidad el objetivo cambia por posición: no se marca ninguna).
export function nearestCell(params, grid) {
  const p = params || {};
  if (p.takeProfitMode && p.takeProfitMode !== 'fixed') return null;
  const tp = toNumber(p.takeProfitPct);
  if (tp === null) return null;
  const numTps = grid.tps.filter((t) => t !== null);
  const numHolds = grid.holds.filter((h) => h !== null);
  if (!numTps.length) return null;
  const maxHold = toNumber(p.maxHoldMinutes);
  const hold = maxHold > 0 && numHolds.length ? nearest(numHolds, maxHold / 60) : (grid.holds.includes(null) ? null : numHolds[numHolds.length - 1] ?? null);
  return { tp: nearest(numTps, tp), hold };
}

// Stop del selector que más se acerca al del bot (sin stop si no tiene).
export function defaultStop(params) {
  const s = toNumber(params?.stopLossPct);
  if (!(s > 0)) return null;
  return nearest(STOP_OPTIONS.map((o) => o.value).filter((v) => v !== null), s);
}

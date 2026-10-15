// Lógica pura de la pestaña Backtesting: fuentes de precios, formulario →
// payload de POST /options/backtests, normalización del resultado y CSV.
import { formatMonthYear, formatPct, formatUsdt, pick, toMs, toNumber } from '../strategies/common/format';
import { validateParams } from '../strategies/common/paramSchema';
import { templateLabel } from '../strategies/strategyView';

export const DVOL_UNDERLYINGS = ['BTC', 'ETH'];

export const SOURCES = [
  {
    key: 'recorded',
    label: 'IV registrada por la app',
    short: 'IV registrada',
    hint: 'Snapshots de la cadena de Binance que guardamos cada hora. Exacta, pero solo desde que se activa el módulo.',
    hintShort: 'Exacta, desde que se activa el módulo',
    note: 'Precios reales de la cadena de Binance grabados por la app. El periodo pedido se recorta al primer snapshot disponible.',
    noteShort: 'Precios reales de Binance grabados por la app.',
  },
  {
    key: 'dvol',
    label: 'Índice DVOL + sonrisa',
    short: 'DVOL',
    hint: 'Black-Scholes con la volatilidad implícita histórica de Deribit (BTC y ETH) y una sonrisa fija.',
    hintShort: 'BTC y ETH · Black-Scholes',
    note: 'Precios sintéticos: Black-Scholes con DVOL de Deribit y una sonrisa de volatilidad aproximada. Binance no publica precios de opciones vencidas, así que el resultado es una estimación.',
    noteShort: 'Precios sintéticos (Black-Scholes con DVOL de Deribit): es una estimación.',
  },
  {
    key: 'realized',
    label: 'Volatilidad realizada',
    short: 'Vol. realizada',
    hint: 'Black-Scholes con la volatilidad realizada de 30 días más una prima configurable. Sirve para todos los subyacentes.',
    hintShort: 'Todos los subyacentes · más grueso',
    note: 'Precios sintéticos con volatilidad realizada a 30 días más una prima de riesgo. Es la aproximación más gruesa; úsala para SOL, BNB, XRP y DOGE.',
    noteShort: 'Precios sintéticos con volatilidad realizada a 30 días más una prima.',
  },
];

export const sourceByKey = (key) => SOURCES.find((s) => s.key === key) || SOURCES[0];

export function sourceAvailable(source, underlying) {
  return source !== 'dvol' || DVOL_UNDERLYINGS.includes(String(underlying || '').toUpperCase());
}

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

// Date → 'YYYY-MM-DD' (UTC).
export function isoDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 'YYYY-MM-DD' → ms al inicio del día UTC (null si no es una fecha).
export function dayToMs(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function defaultForm({ underlying, now = Date.now() } = {}) {
  const today = dayToMs(isoDay(now));
  return {
    selection: '',
    params: {},
    underlying: underlying || 'BTC',
    from: isoDay(today - 365 * DAY_MS),
    to: isoDay(today),
    capitalUsdt: 5000,
    source: 'dvol',
    spreadPct: 3,
    feePct: 0.03,
    volPremiumPct: 10,
  };
}

// La selección es 's:<id>' (estrategia guardada) o 't:<plantilla>'.
export function parseSelection(selection) {
  const m = /^([st]):(.+)$/.exec(String(selection || ''));
  if (!m) return null;
  return m[1] === 's' ? { kind: 'strategy', id: m[2] } : { kind: 'template', id: m[2] };
}

export function selectedStrategy(form, strategies) {
  const sel = parseSelection(form.selection);
  if (sel?.kind !== 'strategy') return null;
  return strategies.find((s) => String(s.id) === sel.id) || null;
}

export function validateBacktestForm(form, { templates = [], strategies = [], now = Date.now() } = {}) {
  const errors = {};
  const sel = parseSelection(form.selection);
  if (!sel) errors.selection = 'Elige una estrategia o una plantilla';
  else if (sel.kind === 'strategy' && !selectedStrategy(form, strategies)) errors.selection = 'La estrategia ya no existe';
  else if (sel.kind === 'template') {
    const t = templates.find((x) => x.id === sel.id);
    const pe = validateParams(t?.paramSchema, form.params);
    if (Object.keys(pe).length) errors.params = pe;
  }
  if (!form.underlying) errors.underlying = 'Elige un subyacente';
  const from = dayToMs(form.from);
  const to = dayToMs(form.to);
  if (from === null) errors.from = 'Fecha no válida';
  if (to === null) errors.to = 'Fecha no válida';
  if (from !== null && to !== null && from >= to) errors.to = 'Debe ser posterior a «Desde»';
  if (to !== null && to > dayToMs(isoDay(now))) errors.to = 'No puede ser futura';
  if (!(Number(form.capitalUsdt) > 0)) errors.capitalUsdt = 'Debe ser mayor que 0';
  if (!sourceAvailable(form.source, form.underlying)) errors.source = 'DVOL solo existe para BTC y ETH';
  if (!(Number(form.spreadPct) >= 0)) errors.spreadPct = 'No puede ser negativo';
  if (!(Number(form.feePct) >= 0)) errors.feePct = 'No puede ser negativo';
  if (form.source === 'realized' && !Number.isFinite(Number(form.volPremiumPct))) errors.volPremiumPct = 'Debe ser un número';
  return errors;
}

export function countErrors(errors) {
  return Object.entries(errors).reduce((n, [k, v]) => n + (k === 'params' ? Object.keys(v).length : 1), 0);
}

// Cuerpo de POST /options/backtests (contrato del spec, Backend B).
// `from`/`to` van en ms UTC: inicio del día de «Desde» y fin del de «Hasta».
export function buildBacktestPayload(form) {
  const sel = parseSelection(form.selection);
  const payload = sel?.kind === 'strategy'
    ? { strategyId: /^\d+$/.test(sel.id) ? Number(sel.id) : sel.id }
    : { template: sel?.id, params: form.params };
  Object.assign(payload, {
    underlying: form.underlying,
    from: dayToMs(form.from),
    to: dayToMs(form.to) + DAY_MS - 1,
    capitalUsdt: Number(form.capitalUsdt),
    source: form.source,
    spreadPct: Number(form.spreadPct),
    feePct: Number(form.feePct),
  });
  if (form.source === 'realized') payload.volPremiumPct = Number(form.volPremiumPct);
  return payload;
}

// ── Ejecuciones ──────────────────────────────────────────────────────
export const STATUS_LABEL = { queued: 'En cola', running: 'Ejecutando', done: 'Lista', failed: 'Falló' };

export const isFinished = (status) => status === 'done' || status === 'failed';

export function normalizeRun(raw = {}) {
  let config = raw.config || {};
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch { config = {}; } }
  let result = raw.result || null;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = null; } }
  return {
    ...raw,
    id: raw.id,
    status: raw.status || 'queued',
    config,
    result,
    error: raw.error || null,
    createdAt: toMs(pick(raw, 'createdAt', 'created_at')),
    finishedAt: toMs(pick(raw, 'finishedAt', 'finished_at')),
    strategyId: pick(raw, 'strategyId', 'strategy_id') ?? config.strategyId ?? null,
  };
}

export function runTitle(run, { strategies = [], templates = [] } = {}) {
  const cfg = run.config || {};
  const sid = run.strategyId ?? cfg.strategyId;
  if (sid !== null && sid !== undefined) {
    const s = strategies.find((x) => String(x.id) === String(sid));
    return s?.name || run.strategyName || `Estrategia #${sid}`;
  }
  return cfg.template ? templateLabel(templates, cfg.template) : 'Backtest';
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// «1 oct 2025» en UTC: el periodo del backtest se define en días UTC.
export function formatUtcDay(value) {
  const ms = toMs(value);
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function runSubtitle(run) {
  const cfg = run.config || {};
  const parts = [];
  if (cfg.underlying) parts.push(cfg.underlying);
  if (cfg.from && cfg.to) parts.push(`${formatUtcDay(cfg.from)} → ${formatUtcDay(cfg.to)}`);
  if (cfg.source) parts.push(sourceByKey(cfg.source).short);
  return parts.join(' · ');
}

// ── Resultado ────────────────────────────────────────────────────────
export function buildMetrics(metrics = {}, { capitalUsdt, equity } = {}) {
  const m = metrics || {};
  const ret = toNumber(m.returnPct);
  const lastValue = toNumber(Array.isArray(equity) ? equity.at(-1)?.strategy : null);
  const capital = toNumber(capitalUsdt);
  const pnl = toNumber(m.pnlUsdt) ?? (lastValue !== null && capital !== null ? lastValue - capital : null);
  const dd = toNumber(m.maxDrawdownPct);
  const worst = toNumber(m.worstCycleUsdt);
  const wins = toNumber(m.wins);
  const cycles = toNumber(m.cycles);
  const ddValue = dd === null ? null : -Math.abs(dd);
  return [
    { key: 'returnPct', label: 'Retorno', value: formatPct(ret, { sign: true }), tone: ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neutral' },
    { key: 'pnlUsdt', label: 'P&L neto', value: pnl === null ? '—' : `${formatUsdt(pnl, { sign: true })} USDT`, tone: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neutral' },
    { key: 'maxDrawdownPct', label: 'Máx. drawdown', value: formatPct(ddValue), tone: ddValue < 0 ? 'neg' : 'neutral' },
    { key: 'sharpe', label: 'Sharpe', value: toNumber(m.sharpe) === null ? '—' : formatUsdt(m.sharpe), tone: 'neutral' },
    { key: 'wins', label: 'Ciclos ganadores', shortLabel: 'Ganadores', value: wins === null ? '—' : `${wins} / ${cycles ?? '—'}`, tone: 'neutral' },
    { key: 'premiumUsdt', label: 'Prima cobrada', value: toNumber(m.premiumUsdt) === null ? '—' : `${formatUsdt(m.premiumUsdt, { decimals: 0 })} USDT`, tone: 'neutral' },
    { key: 'worstCycleUsdt', label: 'Peor ciclo', value: worst === null ? '—' : `${formatUsdt(worst, { decimals: 0, sign: true })} USDT`, tone: worst < 0 ? 'neg' : 'neutral' },
  ];
}

export function buildBacktestEquity(equity) {
  const rows = (Array.isArray(equity) ? equity : [])
    .map((p) => ({ t: toMs(pick(p, 't', 'time')), strategy: toNumber(p.strategy), hodl: toNumber(p.hodl) }))
    .filter((p) => p.t !== null)
    .sort((a, b) => a.t - b.t);
  return { times: rows.map((r) => r.t), strategy: rows.map((r) => r.strategy), hodl: rows.map((r) => r.hodl) };
}

// 'BTC-261003-70000-C' → '70000-C'.
function shortSymbol(symbol) {
  const parts = String(symbol || '').split('-');
  return parts.length >= 4 ? `${parts[2]}-${parts[3]}` : String(symbol || '');
}

export function formatLegs(legs) {
  if (!legs) return '—';
  if (typeof legs === 'string') return legs || '—';
  if (!Array.isArray(legs) || !legs.length) return '—';
  return legs.map((l) => {
    if (typeof l === 'string') return l;
    const side = String(l.side || '').toUpperCase();
    const s = side === 'SELL' ? 'V' : side === 'BUY' ? 'C' : '';
    const type = l.type ? String(l.type).charAt(0).toUpperCase() : '';
    const body = l.symbol ? shortSymbol(l.symbol) : `${l.strike ?? ''}${type ? `-${type}` : ''}`;
    return `${s} ${body}`.trim();
  }).join(' · ');
}

// Códigos de salida del motor (templates y backtest) → texto de la tabla.
const EXIT_REASON_LABEL = {
  take_profit: 'Toma de ganancia',
  stop_loss: 'Stop por pérdida',
  delta_stop: 'Stop por delta',
  time_exit: 'Salida por tiempo',
  roll: 'Roll',
  expiry: 'Vencimiento',
  open: 'Abierto al final',
};

export function exitReasonLabel(code) {
  if (!code) return '';
  return EXIT_REASON_LABEL[code] || code;
}

export function normalizeCycles(cycles) {
  return (Array.isArray(cycles) ? cycles : []).map((c, i) => ({
    id: i,
    openedAt: toMs(pick(c, 'openedAt', 'opened_at')),
    expiry: toMs(c.expiry) ?? c.expiry ?? null,
    legsText: formatLegs(c.legs),
    premium: toNumber(pick(c, 'premiumUsdt', 'premium_usdt')),
    exitReason: exitReasonLabel(pick(c, 'exitReason', 'exit_reason')),
    pnl: toNumber(pick(c, 'pnlUsdt', 'pnl_usdt')),
  }));
}

export function periodLabel(form) {
  const from = dayToMs(form.from);
  const to = dayToMs(form.to);
  if (from === null || to === null) return '';
  return `${formatMonthYear(from)} → ${formatMonthYear(to)}`;
}

// ── CSV ──────────────────────────────────────────────────────────────
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const isoOrRaw = (v) => {
  const ms = toMs(v);
  return ms === null ? (v ?? '') : new Date(ms).toISOString();
};

export function cyclesToCsv(cycles) {
  const header = ['apertura', 'vencimiento', 'patas', 'prima_usdt', 'salida', 'pnl_usdt'];
  const rows = normalizeCycles(cycles).map((c) => [
    isoOrRaw(c.openedAt),
    isoOrRaw(c.expiry),
    c.legsText === '—' ? '' : c.legsText,
    c.premium ?? '',
    c.exitReason,
    c.pnl ?? '',
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

export function downloadCsv(filename, text) {
  // BOM para que Excel lea el UTF-8 (acentos) sin preguntar.
  const blob = new Blob([String.fromCharCode(0xfeff), text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

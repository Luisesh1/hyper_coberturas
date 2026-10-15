// Transformaciones puras de las respuestas de /options/strategies a lo que
// pintan las vistas. Toleran camelCase y snake_case porque el contrato del
// spec fija los nombres de alto nivel pero no todos los campos internos.
import { formatPct, formatUsdt, pick, toMs, toNumber } from './common/format';
import { humanizeKey } from './common/paramSchema';

export const MODES = ['paused', 'shadow', 'live'];

export const MODE_LABEL = { paused: 'Pausada', shadow: 'Sombra', live: 'Real' };

export const UNDERLYINGS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];

const TEMPLATE_FALLBACK = {
  short_strangle: 'Strangle corto',
  covered_call: 'Call cubierta',
  protective_put: 'Put protectora',
};

export function templateLabel(templates, id) {
  const t = (templates || []).find((x) => x.id === id);
  return t?.label || TEMPLATE_FALLBACK[id] || humanizeKey(id);
}

export function normalizeStrategy(raw = {}) {
  const pnl = raw.pnl30d || raw.pnl_30d || {};
  return {
    ...raw,
    id: raw.id,
    name: raw.name || `Estrategia ${raw.id ?? ''}`.trim(),
    template: raw.template,
    underlying: raw.underlying,
    mode: MODES.includes(raw.mode) ? raw.mode : 'paused',
    status: raw.status || '',
    params: raw.params || {},
    limits: raw.limits || {},
    pnlShadow: toNumber(pnl.shadow),
    pnlLive: toNumber(pnl.live),
  };
}

export function sumPnl(strategies, key) {
  let total = 0;
  let any = false;
  for (const s of strategies) {
    const v = s[key];
    if (Number.isFinite(v)) { total += v; any = true; }
  }
  return any ? total : null;
}

// ── KPIs ──────────────────────────────────────────────────────────────
const usdt = (v) => (Number.isFinite(toNumber(v)) ? `${formatUsdt(v, { sign: true })} USDT` : '—');

const KPI_DEFS = [
  { keys: ['pnlShadow', 'shadowPnlUsdt', 'pnlShadowUsdt', 'shadow_pnl_usdt', 'pnl_shadow'], label: 'P&L sombra', kind: 'pnl', hint: 'Llenados simulados' },
  { keys: ['pnlLive', 'livePnlUsdt', 'pnlLiveUsdt', 'live_pnl_usdt', 'pnl_live'], label: 'P&L real', kind: 'pnl', hint: 'Órdenes en Binance' },
  { keys: ['executionDriftPct', 'driftPct', 'slippagePct', 'execution_drift_pct'], label: 'Desvío de ejecución', kind: 'drift', hint: 'Real vs sombra, mismo periodo' },
  { keys: ['premiumUsdt', 'premiumCollectedUsdt', 'premium_usdt'], label: 'Prima cobrada', kind: 'plain', hint: 'USDT' },
  { keys: ['marginUsedUsdt', 'margin_used_usdt'], label: 'Margen en uso', kind: 'margin', hint: 'Límite de la estrategia' },
  { keys: ['cycles', 'cyclesCount'], label: 'Ciclos', kind: 'count', hint: 'Abiertos y cerrados' },
  { keys: ['winRatePct', 'win_rate_pct'], label: 'Ciclos ganadores', kind: 'pct', hint: '' },
];

function kpiFromDef(def, value, ctx) {
  const n = toNumber(value);
  switch (def.kind) {
    case 'pnl':
      return { label: def.label, value: usdt(n), tone: n > 0 ? 'pos' : n < 0 ? 'neg' : 'neutral', hint: def.hint };
    case 'drift':
      return { label: def.label, value: formatPct(n, { sign: true }), tone: n === null || n === 0 ? 'neutral' : 'warn', hint: def.hint };
    case 'margin': {
      const max = toNumber(ctx.limits?.maxMarginUsdt ?? ctx.limits?.max_margin_usdt);
      const v = max ? `${formatUsdt(n, { decimals: 0 })} / ${formatUsdt(max, { decimals: 0 })}` : formatUsdt(n);
      return { label: def.label, value: v, tone: 'neutral', hint: max ? def.hint : 'USDT' };
    }
    case 'count':
      return { label: def.label, value: n === null ? '—' : String(n), tone: 'neutral', hint: def.hint };
    case 'pct':
      return { label: def.label, value: formatPct(n), tone: 'neutral', hint: def.hint };
    default:
      return { label: def.label, value: formatUsdt(n), tone: 'neutral', hint: def.hint };
  }
}

export function buildKpis(detail = {}) {
  const raw = detail.kpis;
  const limits = detail.limits || {};
  if (Array.isArray(raw)) {
    return raw.map((k) => ({
      label: k.label || humanizeKey(k.key),
      value: typeof k.value === 'number' ? formatUsdt(k.value) : String(k.value ?? '—'),
      tone: k.tone || 'neutral',
      hint: k.hint || '',
    }));
  }
  const obj = raw && typeof raw === 'object' ? raw : {};
  const pnl = detail.pnl30d || {};
  const used = new Set();
  const out = [];
  for (const def of KPI_DEFS) {
    const key = def.keys.find((k) => obj[k] !== undefined && obj[k] !== null);
    let value = key ? obj[key] : undefined;
    if (key) used.add(key);
    if (value === undefined && def.label === 'P&L sombra') value = pnl.shadow;
    if (value === undefined && def.label === 'P&L real') value = pnl.live;
    if (value === undefined) {
      if (def.kind === 'pnl') out.push(kpiFromDef(def, null, { limits }));
      continue;
    }
    out.push(kpiFromDef(def, value, { limits }));
  }
  // Lo que el servidor añada y no conozcamos se muestra tal cual (salvo los
  // consumos de límites, que van en las barras de «Límites de riesgo»).
  for (const [k, v] of Object.entries(obj)) {
    if (used.has(k) || LIMIT_USAGE_KEYS.has(k) || (typeof v !== 'number' && typeof v !== 'string')) continue;
    out.push({ label: humanizeKey(k), value: typeof v === 'number' ? formatUsdt(v) : v, tone: 'neutral', hint: '' });
  }
  return out;
}

// ── Curva de P&L ──────────────────────────────────────────────────────
export function buildEquity(equity) {
  const rows = (Array.isArray(equity) ? equity : [])
    .map((p) => ({ t: toMs(pick(p, 't', 'time', 'ts')), shadow: toNumber(p.shadow), live: toNumber(p.live) }))
    .filter((p) => p.t !== null)
    .sort((a, b) => a.t - b.t);
  const liveStartIndex = rows.findIndex((p) => p.live !== null);
  return {
    times: rows.map((p) => p.t),
    shadow: rows.map((p) => p.shadow),
    live: rows.map((p) => p.live),
    liveStartIndex,
    hasLive: liveStartIndex >= 0,
  };
}

// ── Registro de decisiones ────────────────────────────────────────────
export const ACTION_LABEL = { open: 'Abrir', close: 'Cerrar', hold: 'Mantener', skip: 'Omitir', error: 'Error' };

export function normalizeEvents(events) {
  return (Array.isArray(events) ? events : [])
    .map((e, i) => {
      const premium = toNumber(pick(e, 'premiumUsdt', 'premium_usdt', 'premium'));
      return {
        id: e.id ?? `${i}`,
        at: toMs(pick(e, 'createdAt', 'created_at', 't')),
        mode: e.mode === 'live' ? 'live' : 'shadow',
        action: e.action,
        actionLabel: ACTION_LABEL[e.action] || humanizeKey(e.action),
        detail: e.detail || '',
        premium,
      };
    })
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// ── Patas abiertas ────────────────────────────────────────────────────
export function openLegs(detail = {}) {
  const raw = detail.positions || detail.openPositions || detail.state?.legs || detail.state?.openLegs || [];
  return (Array.isArray(raw) ? raw : [])
    .filter((p) => !pick(p, 'closedAt', 'closed_at'))
    .map((p, i) => {
      const symbol = p.symbol || '';
      const type = p.type || (/-C$/.test(symbol) ? 'Call' : /-P$/.test(symbol) ? 'Put' : '');
      const side = String(p.side || '').toUpperCase();
      return {
        id: p.id ?? `${symbol}-${i}`,
        side: side === 'SELL' ? 'Vender' : side === 'BUY' ? 'Comprar' : (p.side || '—'),
        sideTone: side === 'SELL' ? 'neg' : side === 'BUY' ? 'pos' : 'neutral',
        type: type === 'C' ? 'Call' : type === 'P' ? 'Put' : type,
        symbol,
        quantity: toNumber(p.quantity),
        mode: p.mode === 'live' ? 'live' : p.mode === 'shadow' ? 'shadow' : null,
      };
    });
}

// ── Límites de riesgo (barra = uso / máximo) ──────────────────────────
const LIMIT_DEFS = [
  { limit: ['maxMarginUsdt', 'max_margin_usdt'], usage: ['marginUsedUsdt', 'margin_used_usdt'], label: 'Margen máximo', unit: 'USDT', bar: 'indigo' },
  { limit: ['maxDailyLossUsdt', 'max_daily_loss_usdt'], usage: ['dailyLossUsdt', 'daily_loss_usdt'], label: 'Pérdida diaria máx.', unit: 'USDT', bar: 'red' },
  { limit: ['maxNetDelta', 'max_net_delta'], usage: ['netDelta', 'net_delta'], label: '|Δ| neto máx.', unit: '', bar: 'green', abs: true },
  { limit: ['maxOrdersPerDay', 'max_orders_per_day'], usage: ['ordersToday', 'orders_today'], label: 'Órdenes por día', unit: '', bar: 'cyan', integer: true },
];

const LIMIT_USAGE_KEYS = new Set(LIMIT_DEFS.flatMap((d) => d.usage));

export function buildLimits(detail = {}) {
  const limits = detail.limits || {};
  const usage = { ...(detail.kpis && !Array.isArray(detail.kpis) ? detail.kpis : {}), ...(detail.usage || {}) };
  const rows = [];
  for (const def of LIMIT_DEFS) {
    const max = toNumber(pick(limits, ...def.limit));
    if (max === null) continue;
    let used = toNumber(pick(usage, ...def.usage));
    if (used !== null && def.abs) used = Math.abs(used);
    const dec = def.integer ? 0 : (max < 10 ? 2 : 0);
    const value = `${used === null ? '—' : formatUsdt(used, { decimals: dec })} / ${formatUsdt(max, { decimals: dec })}${def.unit ? ` ${def.unit}` : ''}`;
    const pct = used === null || max <= 0 ? 0 : Math.min(100, Math.max(0, (used / max) * 100));
    rows.push({ key: def.limit[0], label: def.label, value, pct, bar: def.bar });
  }
  return rows;
}

// Mensaje de error del servidor que pide ir a configurar credenciales.
export function isCredentialsError(err) {
  const text = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  return /credencial|credential|api ?key|not configured|no configurad/.test(text);
}

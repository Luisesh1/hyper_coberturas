// Transformaciones puras de la pestaña «Trading automatizado»: estructura y
// sus valores por defecto, vista previa de qué abre cada dirección,
// validación y payload del formulario, KPIs y registro de señales.
// Contrato: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md
import { formatNumber, formatPct, formatUsdt, pick, toMs, toNumber } from '../strategies/common/format';
import { normalizeStrategy } from '../strategies/strategyView';

export const BOT_MODE_LABEL = { paused: 'Pausado', shadow: 'Sombra', live: 'Real' };

// Estado del runner (strategies service: waiting | paused | error | in_position;
// también los motivos de espera del tick).
export const STATUS_LABEL = {
  waiting: 'Esperando señal',
  waiting_signal: 'Esperando señal',
  paused: 'Pausado',
  in_position: 'En posición',
  error: 'Con error',
  no_quote: 'Sin cotización',
  no_volatility_tp: 'Sin volatilidad para el objetivo',
};
export const statusLabel = (status) => (status ? STATUS_LABEL[status] || 'Sin estado' : '—');

// ── Dirección de una alerta ───────────────────────────────────────────
export const DIRECTIONS = ['bullish', 'bearish', 'neutral'];
export const DIRECTION_LABEL = { bullish: 'Alcista', bearish: 'Bajista', neutral: 'Neutral' };
export const normalizeDirection = (d) => (DIRECTIONS.includes(d) ? d : 'neutral');

// Direcciones distintas de las alertas de un bot (alcista antes que bajista).
export function botDirections(alerts) {
  const set = new Set((alerts || []).map((a) => normalizeDirection(a?.direction)));
  return DIRECTIONS.filter((d) => set.has(d));
}

// ── Estructura ────────────────────────────────────────────────────────
export const STRUCTURES = ['buy_with', 'sell_against'];

export const STRUCTURE_INFO = {
  buy_with: {
    label: 'Comprar a favor',
    hint: 'Alcista → call, bajista → put. Pérdida máx. = la prima.',
    short: 'compra a favor de la señal',
    shorter: 'compra a favor',
  },
  sell_against: {
    label: 'Vender en contra',
    hint: 'Alcista → vende put, bajista → vende call. Cobra prima, usa margen.',
    short: 'vende en contra de la señal',
    shorter: 'vende en contra',
  },
};

export const normalizeStructure = (s) => (STRUCTURES.includes(s) ? s : 'buy_with');

// Valores que cambian con la estructura (spec B · plantilla alert_signal).
export const STRUCTURE_DEFAULTS = {
  buy_with: { targetDelta: 0.35, takeProfitPct: 80, stopLossPct: 50, maxPremiumUsdt: 150, maxMarginUsdt: null },
  sell_against: { targetDelta: 0.25, takeProfitPct: 50, stopLossPct: 200, maxPremiumUsdt: null, maxMarginUsdt: 1000 },
};

export const COMMON_DEFAULTS = {
  expiryDays: 7,
  // Rango opcional de vencimientos (días); null/null = sin restricción.
  expiryMinDays: null,
  expiryMaxDays: null,
  quantity: 0.01,
  contractCount: 1,
  capitalUsdt: null,
  budgetUsdt: null,
  budgetFractions: 4,
  takeProfitMode: 'fixed',
  tpAtrMultiplier: 1,
  tpHorizonHours: 4,
  atrBandInterval: '1h',
  atrBandLength: 14,
  atrBandMultiplier: 2,
  tpMaxGainPct: 200,
  maxSpreadPct: null,
  minLeverage: null,
  onOpposite: 'reverse',
  exitHoursBeforeExpiry: 12,
  maxOpenPositions: 1,
  maxTradesPerDay: 4,
  notifyTrades: true,
  notifyErrors: true,
};

export const TAKE_PROFIT_MODES = [
  { value: 'atr_band', label: 'Banda ATR' },
  { value: 'fixed', label: 'Porcentaje fijo' },
  { value: 'volatility', label: 'Volatilidad ATR + IV' },
];

// «Banda ATR» solo existe al comprar a favor de la señal.
export const takeProfitModesFor = (structure) => TAKE_PROFIT_MODES
  .filter((m) => m.value !== 'atr_band' || normalizeStructure(structure) === 'buy_with');

export const ATR_BAND_INTERVALS = ['5m', '15m', '1h', '4h', '1d'];

export const ATR_BAND_NOTE = 'Sin stop ni salida por tiempo: si no se alcanza el objetivo, la opción se mantiene hasta su vencimiento y puede perderse toda la prima.';
export const ATR_BAND_SWITCH_WARNING = 'Las posiciones abiertas calcularán su objetivo con el precio actual, no con el de su compra.';

export const ON_OPPOSITE = [
  { value: 'reverse', label: 'Girar', help: 'Cierra y abre en la nueva dirección' },
  { value: 'close', label: 'Solo cerrar', help: 'Cierra la posición y no abre otra' },
  { value: 'ignore', label: 'Ignorar', help: 'Mantiene la posición abierta' },
];

// Qué abre cada dirección con la estructura y el delta elegidos.
export function buildMapping(structure, { targetDelta, expiryDays } = {}) {
  const buy = normalizeStructure(structure) === 'buy_with';
  const d = toNumber(targetDelta) ?? STRUCTURE_DEFAULTS[buy ? 'buy_with' : 'sell_against'].targetDelta;
  const days = toNumber(expiryDays) ?? COMMON_DEFAULTS.expiryDays;
  const delta = (sign) => formatNumber(sign * Math.abs(d), { decimals: 2 });
  const venc = `venc. ~${formatNumber(days, { decimals: 0 })} d`;
  // Delta ≥ 0,9 no lo alcanza ninguna OTM: el bot toma la más cercana al spot.
  if (Math.abs(d) >= 0.9) {
    const detail = `Más cercana al precio · ${venc}`;
    return [
      { direction: 'bullish', action: buy ? 'Comprar call' : 'Vender put', side: buy ? 'buy' : 'sell', detail },
      { direction: 'bearish', action: buy ? 'Comprar put' : 'Vender call', side: buy ? 'buy' : 'sell', detail },
    ];
  }
  return [
    {
      direction: 'bullish',
      action: buy ? 'Comprar call' : 'Vender put',
      side: buy ? 'buy' : 'sell',
      detail: `Δ ≈ ${delta(buy ? 1 : -1)} · ${venc}`,
    },
    {
      direction: 'bearish',
      action: buy ? 'Comprar put' : 'Vender call',
      side: buy ? 'buy' : 'sell',
      detail: `Δ ≈ ${delta(buy ? -1 : 1)} · ${venc}`,
    },
  ];
}

// Etiquetas de salidas y riesgo según la estructura (como en el diseño).
export function structureLabels(structure) {
  const buy = normalizeStructure(structure) === 'buy_with';
  return {
    takeProfit: buy ? 'Toma de ganancia' : 'Recomprar al',
    takeProfitHelp: buy ? 'Ganancia sobre la prima pagada' : 'Porcentaje de la prima cobrada',
    stopLoss: 'Stop',
    stopLossHelp: buy ? 'Pérdida sobre la prima pagada' : 'Recompra si la prima sube a este % de la cobrada',
    risk: buy ? 'Prima máx. por operación' : 'Margen máximo',
  };
}

// ── Bots ──────────────────────────────────────────────────────────────
export function normalizeAlert(raw = {}) {
  const assets = raw.assetList ?? raw.asset_list ?? raw.assets ?? [];
  return {
    id: raw.id,
    name: raw.name || `Alerta ${raw.id ?? ''}`.trim(),
    direction: normalizeDirection(raw.direction),
    assetList: Array.isArray(assets) ? assets : String(assets || '').split(',').map((s) => s.trim()).filter(Boolean),
    thresholdPercent: toNumber(pick(raw, 'thresholdPercent', 'threshold_percent')),
    coveredUnderlyings: Array.isArray(raw.coveredUnderlyings) ? raw.coveredUnderlyings : null,
  };
}

// Subyacentes que opera un bot: `underlyings` del listado, `params.underlyings`
// o, en un bot de siempre, solo su `underlying`.
export function rawBotUnderlyings(raw = {}) {
  const list = [raw.underlyings, raw.params?.underlyings].find((l) => Array.isArray(l) && l.length);
  if (list) return list.map((u) => String(u).toUpperCase());
  return raw.underlying ? [String(raw.underlying).toUpperCase()] : [];
}

// Subyacentes de `underlyings` que vigila la alerta (por BTCUSDT → BTC).
export function coveredList(alert, underlyings = []) {
  if (Array.isArray(alert.coveredUnderlyings)) return underlyings.filter((u) => alert.coveredUnderlyings.includes(u));
  return underlyings.filter((u) => (alert.assetList || []).some((a) => String(a).toUpperCase().startsWith(u)));
}

export function alertMeta(alert) {
  const parts = [];
  if (alert.assetList?.length) parts.push(alert.assetList.join(', '));
  if (alert.thresholdPercent !== null && alert.thresholdPercent !== undefined) {
    parts.push(`umbral ${formatNumber(alert.thresholdPercent, { decimals: 0 })} %`);
  }
  return parts.join(' · ');
}

export function normalizeBot(raw = {}) {
  const base = normalizeStrategy(raw);
  const params = base.params || {};
  const alerts = Array.isArray(raw.alerts) ? raw.alerts.map(normalizeAlert) : [];
  const alertIds = Array.isArray(params.alertIds) ? params.alertIds : alerts.map((a) => a.id);
  return {
    ...base,
    name: raw.name || `Bot ${raw.id ?? ''}`.trim(),
    alerts,
    alertIds,
    underlyings: rawBotUnderlyings(raw),
    structure: normalizeStructure(params.structure),
    statusLabel: statusLabel(base.status),
    lastSignal: raw.lastSignal || raw.last_signal ? normalizeSignal(raw.lastSignal || raw.last_signal) : null,
    pnlSeries: Array.isArray(raw.pnlSeries) ? raw.pnlSeries.map(toNumber).filter((n) => n !== null) : [],
    feesUsdt: toNumber(raw.feesUsdt),
    pendingEntry: raw.pendingEntry && toMs(raw.pendingEntry.deadlineAt) !== null
      ? { ...raw.pendingEntry, deadlineAt: toMs(raw.pendingEntry.deadlineAt) } : null,
    pendingEntryUnknown: raw.pendingEntryUnknown === true,
    blocked: raw.blocked === true,
  };
}

// P&L de la tarjeta: el real si el bot está en real; si no, la sombra.
export const cardPnl = (b) => (b.mode === 'live' && Number.isFinite(b.pnlLive) ? b.pnlLive : b.pnlShadow);

// ── Señales ───────────────────────────────────────────────────────────
export const DECISION_LABEL = {
  opened: 'Abrió',
  closed: 'Cerró',
  reversed: 'Giró',
  ignored: 'Ignorada',
  pending: 'Por confirmar',
  error: 'Error',
};
export const DECISION_TONE = { opened: 'open', closed: 'close', reversed: 'close', ignored: 'skip', pending: 'pending', error: 'error' };
const TRADED = new Set(['opened', 'closed', 'reversed']);
export const isTraded = (s) => TRADED.has(s.decision);

export const SIGNAL_FILTER_OPTIONS = [
  { key: 'all', label: 'Todas' },
  { key: 'traded', label: 'Operadas' },
  { key: 'ignored', label: 'Ignoradas' },
];

// «BTCUSDT» / «SOL-PERP» → «BTC» / «SOL»: subyacente del activo que disparó la alerta.
function assetUnderlying(asset) {
  return String(asset || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/(USDT|USDC|FDUSD|BUSD|USD|PERP)+$/, '');
}

export function normalizeSignal(raw = {}, i = 0) {
  const decision = String(raw.decision || '').toLowerCase();
  return {
    id: raw.id ?? `s${i}`,
    botId: pick(raw, 'strategyId', 'strategy_id', 'botId') ?? null,
    alertId: pick(raw, 'alertId', 'alert_id') ?? null,
    alertName: pick(raw, 'alertName', 'alert_name') || '—',
    direction: normalizeDirection(raw.direction),
    asset: raw.asset || '',
    underlying: assetUnderlying(raw.asset),
    score: toNumber(raw.score),
    decision,
    decisionLabel: DECISION_LABEL[decision] || decision || '—',
    tone: DECISION_TONE[decision] || 'skip',
    detail: raw.detail || '',
    simulated: raw.simulated === true,
    feesUsdt: toNumber(raw.feesUsdt),
    feesEstimated: raw.feesEstimated === true,
    at: toMs(pick(raw, 'createdAt', 'created_at', 'at', 't')),
  };
}

export function normalizeSignals(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeSignal)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// Defensa en el cliente por si el servidor ignora `filter`. Las simuladas
// solo aparecen en «Todas» (con su etiqueta «Simulada»).
export function filterSignals(signals, filter) {
  if (filter === 'traded') return signals.filter((s) => isTraded(s) && !s.simulated);
  if (filter === 'ignored') return signals.filter((s) => s.decision === 'ignored');
  return signals;
}

export const formatScore = (score) => (score === null || score === undefined ? '—' : formatPct(score, { decimals: 0 }));

// Señal más reciente entre todos los bots (tarjeta «Última señal» del móvil).
export function latestSignal(bots) {
  let best = null;
  for (const b of bots || []) {
    const s = b.lastSignal;
    if (!s || s.simulated) continue;
    if (!best || (s.at ?? 0) > (best.signal.at ?? 0)) best = { bot: b, signal: s };
  }
  return best;
}

// ── KPIs ──────────────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const usdtSigned = (v) => (Number.isFinite(v) ? formatUsdt(v, { sign: true }) : '—');
const toneOfPnl = (v) => (!Number.isFinite(v) || v === 0 ? 'neutral' : v > 0 ? 'pos' : 'neg');

export function signalStats(signals, now = Date.now()) {
  const recent = (signals || []).filter((s) => !s.simulated).filter((s) => s.at === null || now - s.at <= 30 * DAY_MS);
  return {
    total: recent.length,
    bullish: recent.filter((s) => s.direction === 'bullish').length,
    bearish: recent.filter((s) => s.direction === 'bearish').length,
    traded: recent.filter(isTraded).length,
  };
}

export const MIN_TRADES_FOR_WIN_RATE = 5;

// El detalle (GET /options/strategies/:id) trae los KPIs por libro:
// { shadow: { pnl30dUsdt, cycles, winRatePct }, live: {...} }.
export function buildBotKpis(bot, stats) {
  const k = bot?.kpis && typeof bot.kpis === 'object' && !Array.isArray(bot.kpis) ? bot.kpis : {};
  const shadow = k.shadow && typeof k.shadow === 'object' ? k.shadow : {};
  const live = k.live && typeof k.live === 'object' ? k.live : {};
  const pnlShadow = toNumber(shadow.pnl30dUsdt) ?? bot?.pnlShadow ?? null;
  const pnlLive = toNumber(live.pnl30dUsdt) ?? bot?.pnlLive ?? null;
  const active = bot?.mode === 'live' ? live : shadow;
  // closedTrades / avgPnlUsdt / maxDrawdownUsdt / longestLosingStreak los
  // calcula el servidor sobre todas las operaciones cerradas del libro activo.
  const closedTrades = toNumber(active.closedTrades);
  const cycles = toNumber(active.cycles);
  const winRate = toNumber(active.winRatePct);
  const wins = cycles !== null && winRate !== null ? Math.round((cycles * winRate) / 100) : null;
  const few = closedTrades !== null && closedTrades < MIN_TRADES_FOR_WIN_RATE;
  const winsValue = few ? `n/a (${closedTrades} ${closedTrades === 1 ? 'op' : 'ops'})`
    : wins !== null ? `${wins} / ${cycles}` : formatPct(winRate, { decimals: 0 });
  const avg = toNumber(active.avgPnlUsdt);
  const dd = toNumber(active.maxDrawdownUsdt);
  const streak = toNumber(active.longestLosingStreak) ?? 0;
  return [
    {
      key: 'signals',
      label: 'Señales 30d',
      value: stats ? String(stats.total) : '—',
      tone: 'neutral',
      hint: stats ? `${stats.bullish} alcistas · ${stats.bearish} bajistas` : '',
    },
    {
      key: 'traded',
      label: 'Operadas',
      value: stats ? String(stats.traded) : '—',
      tone: 'neutral',
      hint: 'el resto, ignoradas por reglas',
    },
    { key: 'pnlShadow', label: 'P&L sombra', value: usdtSigned(pnlShadow), tone: toneOfPnl(pnlShadow), hint: 'USDT · 30 días' },
    { key: 'pnlLive', label: 'P&L real', value: usdtSigned(pnlLive), tone: toneOfPnl(pnlLive), hint: 'USDT · 30 días' },
    {
      key: 'wins',
      label: 'Acierto',
      value: winsValue,
      tone: 'neutral',
      hint: few ? `mínimo ${MIN_TRADES_FOR_WIN_RATE} operaciones cerradas` : 'operaciones ganadoras',
    },
    {
      key: 'avgPnl',
      label: 'P&L medio por operación',
      value: avg !== null ? usdtSigned(avg) : '—',
      tone: avg !== null ? toneOfPnl(avg) : 'neutral',
      hint: 'USDT · operaciones cerradas',
    },
    {
      key: 'drawdown',
      label: 'Peor racha / drawdown',
      value: dd !== null
        ? `${dd > 0 ? usdtSigned(-dd) : formatUsdt(0)} · ${streak} ${streak === 1 ? 'seguida' : 'seguidas'}`
        : '—',
      tone: dd !== null && dd > 0 ? 'neg' : 'neutral',
      hint: 'caída máx. y pérdidas seguidas (USDT)',
    },
  ];
}

// ── Formulario ────────────────────────────────────────────────────────
export const NAME_MAX = 80;

export function initialBotForm({ bot = null, underlying = 'BTC' } = {}) {
  if (bot) {
    const p = bot.params || {};
    const structure = normalizeStructure(p.structure);
    const defs = { ...COMMON_DEFAULTS, ...STRUCTURE_DEFAULTS[structure] };
    const val = (key) => toNumber(p[key]) ?? defs[key];
    return {
      name: bot.name || '',
      underlyings: rawBotUnderlyings(bot).length ? rawBotUnderlyings(bot) : [underlying],
      alertIds: [...(bot.alertIds || [])],
      structure,
      targetDelta: Math.abs(val('targetDelta')),
      expiryDays: val('expiryDays'),
      expiryMinDays: toNumber(p.expiryMinDays),
      expiryMaxDays: toNumber(p.expiryMaxDays),
      quantity: val('quantity'),
      contractCount: val('contractCount'),
      capitalUsdt: toNumber(p.capitalUsdt),
      budgetUsdt: toNumber(p.budgetUsdt),
      budgetFractions: val('budgetFractions'),
      onOpposite: ON_OPPOSITE.some((o) => o.value === p.onOpposite) ? p.onOpposite : defs.onOpposite,
      takeProfitPct: val('takeProfitPct'),
      takeProfitMode: takeProfitModesFor(structure).some((m) => m.value === p.takeProfitMode) ? p.takeProfitMode : 'fixed',
      tpAtrMultiplier: val('tpAtrMultiplier'),
      tpHorizonHours: val('tpHorizonHours'),
      atrBandInterval: ATR_BAND_INTERVALS.includes(p.atrBandInterval) ? p.atrBandInterval : COMMON_DEFAULTS.atrBandInterval,
      atrBandLength: val('atrBandLength'),
      atrBandMultiplier: val('atrBandMultiplier'),
      tpMaxGainPct: val('tpMaxGainPct'),
      stopLossPct: val('stopLossPct'),
      exitHoursBeforeExpiry: val('exitHoursBeforeExpiry'),
      maxOpenPositions: val('maxOpenPositions'),
      maxTradesPerDay: val('maxTradesPerDay'),
      notifyTrades: p.notify?.trades !== false,
      notifyErrors: p.notify?.errors !== false,
      maxPremiumUsdt: structure === 'buy_with' ? (toNumber(p.maxPremiumUsdt) ?? null) : defs.maxPremiumUsdt,
      maxSpreadPct: toNumber(p.maxSpreadPct) ?? null,
      minLeverage: structure === 'buy_with' ? (toNumber(p.minLeverage) ?? null) : null,
      maxMarginUsdt: structure === 'sell_against' ? (toNumber(bot.limits?.maxMarginUsdt) ?? null) : null,
    };
  }
  return {
    name: '',
    underlyings: [underlying],
    alertIds: [],
    structure: 'buy_with',
    ...COMMON_DEFAULTS,
    ...STRUCTURE_DEFAULTS.buy_with,
    // Los bots nuevos que compran a favor nacen con la banda ATR.
    takeProfitMode: 'atr_band',
  };
}

// Al salir de «Banda ATR» el servidor había sobrescrito salida por tiempo y
// stop (0 / sin stop): se restauran los valores de la estructura.
function leaveAtrBand(form, structure) {
  return {
    ...form,
    exitHoursBeforeExpiry: COMMON_DEFAULTS.exitHoursBeforeExpiry,
    stopLossPct: STRUCTURE_DEFAULTS[structure].stopLossPct,
  };
}

export function withTakeProfitMode(form, mode) {
  if (mode === form.takeProfitMode) return form;
  const base = form.takeProfitMode === 'atr_band' ? leaveAtrBand(form, normalizeStructure(form.structure)) : form;
  return { ...base, takeProfitMode: mode };
}

// Cambiar de estructura aplica sus valores por defecto (delta, salidas y riesgo).
// Al pasar a vender se abandona la banda ATR; al editar, comprar no la activa.
export function withStructure(form, structure, { editing = false } = {}) {
  const s = normalizeStructure(structure);
  let next = form;
  if (s !== 'buy_with' && form.takeProfitMode === 'atr_band') {
    next = { ...leaveAtrBand(form, s), takeProfitMode: 'fixed' };
  } else if (s === 'buy_with' && !editing && form.takeProfitMode === 'fixed') {
    next = { ...form, takeProfitMode: 'atr_band' };
  }
  return { ...next, structure: s, ...STRUCTURE_DEFAULTS[s] };
}

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// Presupuesto total: cada señal compromete como máximo una fracción.
// null sin presupuesto o con fracciones inválidas.
export function perSignalBudget({ budgetUsdt, budgetFractions } = {}) {
  const budget = Number(budgetUsdt);
  const fractions = Number(budgetFractions);
  if (!isNum(budgetUsdt) || !(budget > 0) || !Number.isInteger(fractions) || fractions < 1 || fractions > 20) return null;
  return budget / fractions;
}

// `alerts`: las alertas elegibles (con su cobertura); si vienen, cada subyacente
// elegido tiene que estar cubierto por alguna alerta marcada.
export function validateBotForm(form, { alerts } = {}) {
  const errors = {};
  const name = String(form.name || '').trim();
  if (!name) errors.name = 'Ponle un nombre';
  else if (name.length > NAME_MAX) errors.name = `Máximo ${NAME_MAX} caracteres`;
  if (!form.underlyings?.length) errors.underlyings = 'Elige un subyacente';
  if (!form.alertIds?.length) errors.alertIds = 'Elige al menos una alerta';
  else if (alerts && form.underlyings?.length) {
    const picked = alerts.filter((a) => form.alertIds.includes(a.id));
    const missing = form.underlyings.find((u) => !picked.some((a) => coveredList(a, [u]).length));
    if (missing) errors.alertIds = `Ninguna alerta marcada cubre ${missing}`;
  }
  if (!STRUCTURES.includes(form.structure)) errors.structure = 'Elige qué hacer con la señal';

  const range = (key, min, max, { integer = false, minLabel } = {}) => {
    const v = form[key];
    if (!isNum(v)) { errors[key] = 'Obligatorio'; return; }
    const n = Number(v);
    if (integer && !Number.isInteger(n)) errors[key] = 'Debe ser un número entero';
    else if (n < min) errors[key] = minLabel || `Mínimo ${formatNumber(min, { decimals: 2, minDecimals: 0 })}`;
    else if (max !== undefined && n > max) errors[key] = `Máximo ${formatNumber(max, { decimals: 2, minDecimals: 0 })}`;
  };
  range('targetDelta', 0.05, 0.95);
  range('expiryDays', 1, 90, { integer: true });
  const hasMin = isNum(form.expiryMinDays);
  const hasMax = isNum(form.expiryMaxDays);
  if (hasMin && !hasMax) errors.expiryMaxDays = 'Indica también el máximo';
  else if (hasMax && !hasMin) errors.expiryMinDays = 'Indica también el mínimo';
  else if (hasMin && hasMax) {
    range('expiryMinDays', 0, 180);
    range('expiryMaxDays', 0, 180);
    if (!errors.expiryMinDays && !errors.expiryMaxDays && Number(form.expiryMinDays) > Number(form.expiryMaxDays)) {
      errors.expiryMaxDays = 'Debe ser ≥ al mínimo';
    }
  }
  range('quantity', 0.0001, 1000000, { minLabel: 'Debe ser mayor que 0' });
  const hasBudget = isNum(form.budgetUsdt);
  if (hasBudget) {
    if (Number(form.budgetUsdt) <= 0) errors.budgetUsdt = 'El presupuesto debe ser mayor a 0';
    range('budgetFractions', 1, 20, { integer: true });
  } else if (isNum(form.capitalUsdt) && Number(form.capitalUsdt) <= 0) errors.capitalUsdt = 'El capital debe ser mayor a 0';
  if (!takeProfitModesFor(form.structure).some((m) => m.value === form.takeProfitMode)) errors.takeProfitMode = 'Modo de Take Profit inválido';
  if (form.takeProfitMode === 'atr_band') {
    // Stop, salida por tiempo y señal contraria no existen en este modo.
    if (!ATR_BAND_INTERVALS.includes(form.atrBandInterval)) errors.atrBandInterval = 'Elige una temporalidad';
    range('atrBandLength', 2, 100, { integer: true });
    range('atrBandMultiplier', 0.25, 10);
    range('tpMaxGainPct', 10, 2000);
  } else {
    range('takeProfitPct', 1, 1000);
    range('tpAtrMultiplier', 0.25, 4);
    range('tpHorizonHours', 1, 24, { integer: true });
    range('stopLossPct', 1, 1000);
    range('exitHoursBeforeExpiry', 0, 168);
  }
  range('maxOpenPositions', 1, 20, { integer: true });
  range('maxTradesPerDay', 1, 100, { integer: true });
  const riskKey = form.structure === 'sell_against' ? 'maxMarginUsdt' : 'maxPremiumUsdt';
  if (isNum(form[riskKey]) && Number(form[riskKey]) < 0) errors[riskKey] = 'No puede ser negativo';
  if (isNum(form.maxSpreadPct) && !(Number(form.maxSpreadPct) > 0 && Number(form.maxSpreadPct) <= 200)) errors.maxSpreadPct = 'Entre 0 y 200 (vacío = sin filtro)';
  if (form.structure === 'buy_with' && isNum(form.minLeverage) && !(Number(form.minLeverage) > 0 && Number(form.minLeverage) <= 1000)) errors.minLeverage = 'Entre 0 y 1000 (vacío = sin filtro)';
  return errors;
}

// POST /options/auto-bots: { name, underlying, alertIds, params, limits? }.
// PUT /:id acepta `underlyings` (quitar uno con posiciones abiertas da 409).
export function buildBotPayload(form, { editing = false, baseLimits = {} } = {}) {
  const buy = form.structure === 'buy_with';
  const params = {
    structure: form.structure,
    targetDelta: Number(form.targetDelta),
    expiryDays: Number(form.expiryDays),
    expiryMinDays: isNum(form.expiryMinDays) ? Number(form.expiryMinDays) : null,
    expiryMaxDays: isNum(form.expiryMaxDays) ? Number(form.expiryMaxDays) : null,
    quantity: Number(form.quantity),
    // Una sola opción por señal: los bots viejos con más se guardan con 1.
    contractCount: 1,
    // Con presupuesto total el capital por entrada se ignora: no se envía.
    capitalUsdt: !(Number(form.budgetUsdt) > 0) && Number(form.capitalUsdt) > 0 ? Number(form.capitalUsdt) : null,
    budgetUsdt: Number(form.budgetUsdt) > 0 ? Number(form.budgetUsdt) : null,
    // Sin presupuesto el campo de fracciones está oculto: un valor fuera de
    // rango daría un 400 invisible. Se envía el valor por defecto.
    budgetFractions: Number(form.budgetFractions) > 0 && Number(form.budgetUsdt) > 0 &&
      Number.isInteger(Number(form.budgetFractions)) && isNum(form.budgetFractions)
      ? Number(form.budgetFractions) : COMMON_DEFAULTS.budgetFractions,
    onOpposite: form.onOpposite,
    takeProfitPct: Number(form.takeProfitPct),
    takeProfitMode: form.takeProfitMode,
    tpAtrMultiplier: Number(form.tpAtrMultiplier),
    tpHorizonHours: Number(form.tpHorizonHours),
    stopLossPct: Number(form.stopLossPct),
    exitHoursBeforeExpiry: Number(form.exitHoursBeforeExpiry),
    maxOpenPositions: Number(form.maxOpenPositions),
    maxTradesPerDay: Number(form.maxTradesPerDay),
    notify: { trades: form.notifyTrades !== false, errors: form.notifyErrors !== false },
  };
  if (buy && form.takeProfitMode === 'atr_band') {
    // Sin stop ni salida por tiempo; la señal contraria es la elegida.
    delete params.stopLossPct;
    params.exitHoursBeforeExpiry = 0;
    params.atrBandInterval = form.atrBandInterval;
    params.atrBandLength = Number(form.atrBandLength);
    params.atrBandMultiplier = Number(form.atrBandMultiplier);
    params.tpMaxGainPct = Number(form.tpMaxGainPct);
  }
  // Opcionales: vacío/0 = apagado → null. Siempre se envían: el servidor
  // fusiona params al editar y una clave omitida conservaría el valor viejo.
  params.maxPremiumUsdt = buy && Number(form.maxPremiumUsdt) > 0 ? Number(form.maxPremiumUsdt) : null;
  params.maxSpreadPct = Number(form.maxSpreadPct) > 0 ? Number(form.maxSpreadPct) : null;
  params.minLeverage = buy && Number(form.minLeverage) > 0 ? Number(form.minLeverage) : null;
  // 0 o vacío = sin margen propio (sólo el límite global).
  const limits = { ...(baseLimits || {}) };
  if (!buy && Number(form.maxMarginUsdt) > 0) limits.maxMarginUsdt = Number(form.maxMarginUsdt);
  else delete limits.maxMarginUsdt;

  const payload = {
    name: String(form.name).trim(),
    alertIds: [...form.alertIds],
    params,
    limits,
    underlyings: [...form.underlyings],
  };
  if (!editing) payload.underlying = form.underlyings[0];
  return payload;
}

// Resumen legible de los parámetros (tarjetas del detalle).
export function describeParams(bot) {
  const p = bot.params || {};
  const structure = normalizeStructure(p.structure);
  const defs = { ...COMMON_DEFAULTS, ...STRUCTURE_DEFAULTS[structure] };
  const v = (key) => toNumber(p[key]) ?? defs[key];
  const labels = structureLabels(structure);
  const buy = structure === 'buy_with';
  const opposite = ON_OPPOSITE.find((o) => o.value === p.onOpposite) || ON_OPPOSITE[0];
  const premium = toNumber(p.maxPremiumUsdt);
  const margin = toNumber(bot.limits?.maxMarginUsdt);
  const capital = toNumber(p.capitalUsdt);
  const budget = toNumber(p.budgetUsdt);
  const fractions = v('budgetFractions');
  const maxSpread = toNumber(p.maxSpreadPct);
  const minLeverage = toNumber(p.minLeverage);
  const atr = p.takeProfitMode === 'atr_band' && buy;
  const exits = atr
    ? [
      { key: 'takeProfitPct', label: 'Venta por banda ATR',
        value: `${p.atrBandInterval || COMMON_DEFAULTS.atrBandInterval} ${formatNumber(v('atrBandLength'), { decimals: 0 })}/${formatNumber(v('atrBandMultiplier'), { decimals: 2, minDecimals: 0 })} · tope +${formatNumber(v('tpMaxGainPct'), { decimals: 0 })} %` },
      { key: 'stopLossPct', label: 'Sin stop', value: 'se mantiene hasta vencer' },
    ]
    : [
      { key: 'takeProfitPct', label: labels.takeProfit,
        value: p.takeProfitMode === 'volatility'
          ? `ATR × ${formatNumber(v('tpAtrMultiplier'), { decimals: 2, minDecimals: 0 })} + IV · horizonte ${formatNumber(v('tpHorizonHours'), { decimals: 0 })} h`
          : `${buy ? '+' : ''}${formatNumber(v('takeProfitPct'), { decimals: 0 })} % de la prima` },
      { key: 'stopLossPct', label: labels.stopLoss, value: `${buy ? '−' : ''}${formatNumber(v('stopLossPct'), { decimals: 0 })} % de la prima` },
      { key: 'exitHoursBeforeExpiry', label: 'Cerrar antes del venc.', value: `${formatNumber(v('exitHoursBeforeExpiry'), { decimals: 0 })} h` },
    ];
  return {
    entry: [
      { key: 'targetDelta', label: 'Delta objetivo', value: formatNumber(Math.abs(v('targetDelta')), { decimals: 2 }) },
      { key: 'expiryDays', label: 'Vencimiento', value: `${formatNumber(v('expiryDays'), { decimals: 0 })} días` },
      {
        key: 'expiryWindow',
        label: 'Rango de vencimiento',
        value: toNumber(p.expiryMinDays) != null && toNumber(p.expiryMaxDays) != null
          ? `${formatNumber(toNumber(p.expiryMinDays), { decimals: 2, minDecimals: 0 })}–${formatNumber(toNumber(p.expiryMaxDays), { decimals: 2, minDecimals: 0 })} días`
          : 'Sin límite',
      },
      { key: 'quantity', label: 'Cantidad', value: `${formatNumber(v('quantity'), { decimals: 4, minDecimals: 0 })} ${bot.underlying || ''}`.trim() },
      budget
        ? { key: 'budgetUsdt', label: 'Presupuesto total',
          value: `${formatUsdt(budget, { decimals: 2, minDecimals: 0 })} USDT · ${formatNumber(fractions, { decimals: 0 })} fracciones · hasta ${formatUsdt(budget / fractions, { decimals: 2, minDecimals: 0 })} USDT por señal`,
          text: true }
        : { key: 'capitalUsdt', label: 'Capital máx. por entrada', value: capital ? `${formatUsdt(capital, { decimals: 0 })} USDT` : 'sin límite', text: !capital },
      ...(buy ? [{ key: 'maxPremiumUsdt', label: 'Prima máx.', value: premium ? `${formatUsdt(premium, { decimals: 0 })} USDT` : 'sin límite', text: !premium }] : []),
      ...(maxSpread > 0 ? [{ key: 'maxSpreadPct', label: 'Spread máx.', value: `${formatNumber(maxSpread, { decimals: 2, minDecimals: 0 })} %` }] : []),
      ...(buy && minLeverage > 0 ? [{ key: 'minLeverage', label: 'Apalancamiento mín.', value: `${formatNumber(minLeverage, { decimals: 2, minDecimals: 0 })}×` }] : []),
      // La banda ATR fuerza «ignorar» y ya declara que no hay otras salidas.
      { key: 'onOpposite', label: 'Señal contraria', value: opposite.help, text: true },
    ],
    exits,
    risk: [
      { key: 'maxOpenPositions', label: 'Posiciones abiertas máx.', value: formatNumber(v('maxOpenPositions'), { decimals: 0 }) },
      { key: 'maxTradesPerDay', label: 'Operaciones por día', value: formatNumber(v('maxTradesPerDay'), { decimals: 0 }) },
      {
        key: 'risk',
        label: labels.risk,
        value: buy
          ? (premium ? `${formatUsdt(premium, { decimals: 0 })} USDT` : 'Sin límite propio')
          : (margin ? `${formatUsdt(margin, { decimals: 0 })} USDT` : 'Límite global'),
        text: buy ? !premium : !margin,
      },
    ],
  };
}

// ── Estado, flujo, comisiones y escalera de entrada ───────────────────
// Ventana de supervisión de una entrada GTC (igual que el servidor).
export const ENTRY_WINDOW_MS = 10 * 60_000;

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil((toNumber(ms) ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Fracción de la ventana que queda (0–1).
export function entryProgress(remainingMs) {
  return Math.min(1, Math.max(0, (toNumber(remainingMs) ?? 0) / ENTRY_WINDOW_MS));
}

const isOpenPosition = (p) => p && p.closedAt == null;
const qtyText = (n) => formatNumber(n, { decimals: 4, minDecimals: 0 });

// Estado «ahora» del bot, por prioridad: blocked > pending > position > waiting > paused.
// `detail` es opcional (la lista solo trae el resumen del bot).
export function botStatus(bot = {}, detail = null, now = Date.now()) {
  const blockedKeys = Object.keys(detail?.blockedUnderlyings || {});
  if (blockedKeys.length || bot.blocked === true) {
    return {
      kind: 'blocked',
      title: blockedKeys.length ? `Bloqueado: revisa ${blockedKeys.join(', ')}` : 'Bloqueado: revisa el subyacente',
      detail: 'El bot no abre entradas hasta que lo desbloquees.',
    };
  }
  const entries = Array.isArray(detail?.pendingEntries) ? detail.pendingEntries : [];
  const first = [...entries].sort((a, b) => (toMs(a.deadlineAt) ?? Infinity) - (toMs(b.deadlineAt) ?? Infinity))[0];
  const deadlineAt = first ? toMs(first.deadlineAt) : (bot.pendingEntry ? toMs(bot.pendingEntry.deadlineAt) : null);
  if (first || bot.pendingEntry) {
    const remainingMs = deadlineAt === null ? 0 : Math.max(0, deadlineAt - now);
    const title = first
      ? `Entrada pendiente · ${String(first.side).toUpperCase() === 'SELL' ? 'venta' : 'compra'} ${qtyText(first.quantity)} ${first.symbol}`
      : 'Entrada pendiente';
    return {
      kind: 'pending',
      title,
      detail: 'Si no se ejecuta a tiempo, se cancela y el bot espera la siguiente señal.',
      deadlineAt,
      remainingMs,
      progress: entryProgress(remainingMs),
    };
  }
  // Solo cuentan las posiciones del libro del bot: real → live; sombra y
  // pausado → shadow. Con detalle manda el detalle; el «in_position» de la
  // lista solo vale cuando aún no hay detalle.
  const book = bot.mode === 'live' ? 'live' : 'shadow';
  const inPosition = Array.isArray(detail?.positions)
    ? detail.positions.some((p) => isOpenPosition(p) && (p.mode || 'shadow') === book)
    : bot.status === 'in_position';
  if (inPosition) {
    return { kind: 'position', title: 'En posición', detail: 'Vigilando el take profit y el stop.' };
  }
  if (bot.mode === 'paused') {
    return { kind: 'paused', title: 'Pausado', detail: 'No reacciona a señales.' };
  }
  if (bot.pendingEntryUnknown === true && !detail) {
    return { kind: 'waiting', title: 'Esperando señal', detail: 'Estado de la entrada desconocido' };
  }
  return { kind: 'waiting', title: 'Esperando señal', detail: 'Sin posición ni entrada pendiente.' };
}

// Las cuatro etapas del bot, con el texto de la maqueta.
export function flowSteps(bot = {}) {
  const p = bot.params || {};
  const structure = normalizeStructure(bot.structure || p.structure);
  const buy = structure === 'buy_with';
  const defs = { ...COMMON_DEFAULTS, ...STRUCTURE_DEFAULTS[structure] };
  const v = (key) => toNumber(p[key]) ?? defs[key];
  const n0 = (x) => formatNumber(x, { decimals: 0 });
  const alert = (bot.alerts || [])[0];
  const threshold = toNumber(alert?.thresholdPercent ?? alert?.threshold);
  const signalName = alert?.name ? `${alert.name}${threshold !== null ? ` · umbral ${n0(threshold)} %` : ''}` : 'Alertas del bot';
  const atr = p.takeProfitMode === 'atr_band' && buy;
  return [
    { key: 'signal', title: 'Señal', value: '▲ Alcista / ▼ Bajista', subtitle: signalName },
    {
      key: 'contract', title: 'Contrato', value: buy ? 'Compra call / put' : 'Venta put / call',
      subtitle: `Δ ≈ ${formatNumber(Math.abs(v('targetDelta')), { decimals: 2 })} · vence ~${n0(v('expiryDays'))} d`,
    },
    { key: 'entry', title: 'Entrada', value: 'GTC al precio medio', subtitle: 'espera 10 min; si no, se cancela' },
    atr
      ? { key: 'exit', title: 'Salida', value: 'TP banda ATR (GTC)', subtitle: 'sin stop; se mantiene hasta vencer' }
      : {
        key: 'exit', title: 'Salida',
        value: p.takeProfitMode === 'volatility'
          ? `TP volatilidad · Stop ${buy ? '−' : ''}${n0(v('stopLossPct'))} %`
          : `TP ${buy ? '+' : ''}${n0(v('takeProfitPct'))} % · Stop ${buy ? '−' : ''}${n0(v('stopLossPct'))} %`,
        subtitle: `o ${n0(v('exitHoursBeforeExpiry'))} h antes del vencimiento`,
      },
  ];
}

// Comisiones del periodo: total, % de la prima operada y desglose.
export function feeSummary(kpis = {}) {
  const total = toNumber(kpis?.feesUsdt);
  const premium = toNumber(kpis?.premiumUsdt);
  const pct = toNumber(kpis?.feesPctOfPremium) ?? (total !== null && premium > 0 ? (total / premium) * 100 : null);
  const b = kpis?.feeBreakdown;
  const parts = [];
  if (b) {
    parts.push(
      { key: 'entry', label: 'entrada', usdt: toNumber(b.entryUsdt) ?? 0 },
      { key: 'exit', label: 'salida', usdt: toNumber(b.exitUsdt) ?? 0 },
      { key: 'exercise', label: 'ejercicio', usdt: toNumber(b.exerciseUsdt) ?? 0 },
    );
    const un = toNumber(b.unallocatedUsdt);
    if (un > 0) parts.push({ key: 'unallocated', label: 'sin desglose (histórico)', usdt: un });
  }
  return { total, pct, label: pct === null ? '' : `${formatPct(pct, { decimals: 1 })} de la prima operada`, parts };
}

export function signalFeeText(signal = {}) {
  const fee = toNumber(signal?.feesUsdt);
  if (fee === null) return null;
  return `${signal.feesEstimated ? 'Comisión est.' : 'Comisión'} ${formatUsdt(fee)} USDT`;
}

// Posición del límite entre bid y ask (0–100 %) y ahorro por contrato frente
// al lado agresivo (ask al comprar, bid al vender).
export function ladder(entry = {}) {
  const bid = toNumber(entry.bid);
  const ask = toNumber(entry.ask);
  const limit = toNumber(entry.limitPrice);
  if (bid === null || ask === null || limit === null || bid <= 0 || ask < bid) return null;
  const sell = String(entry.side || '').toUpperCase() === 'SELL';
  const round = (x) => Math.round(x * 1e8) / 1e8;
  return {
    bidPct: 0,
    midPct: ask === bid ? 50 : Math.min(100, Math.max(0, ((limit - bid) / (ask - bid)) * 100)),
    askPct: 100,
    savingPerContract: round(sell ? limit - bid : ask - limit),
  };
}

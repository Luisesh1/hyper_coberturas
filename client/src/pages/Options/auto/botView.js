// Transformaciones puras de la pestaña «Trading automatizado»: estructura y
// sus valores por defecto, vista previa de qué abre cada dirección,
// validación y payload del formulario, KPIs y registro de señales.
// Contrato: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md
import { formatNumber, formatPct, formatUsdt, pick, toMs, toNumber } from '../strategies/common/format';
import { normalizeStrategy } from '../strategies/strategyView';

export const BOT_MODE_LABEL = { paused: 'Pausado', shadow: 'Sombra', live: 'Real' };

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
  quantity: 0.01,
  onOpposite: 'reverse',
  exitHoursBeforeExpiry: 12,
  maxOpenPositions: 1,
  maxTradesPerDay: 4,
};

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
  };
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
    structure: normalizeStructure(params.structure),
    lastSignal: raw.lastSignal || raw.last_signal ? normalizeSignal(raw.lastSignal || raw.last_signal) : null,
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
  error: 'Error',
};
export const DECISION_TONE = { opened: 'open', closed: 'close', reversed: 'close', ignored: 'skip', error: 'error' };
const TRADED = new Set(['opened', 'closed', 'reversed']);
export const isTraded = (s) => TRADED.has(s.decision);

export const SIGNAL_FILTER_OPTIONS = [
  { key: 'all', label: 'Todas' },
  { key: 'traded', label: 'Operadas' },
  { key: 'ignored', label: 'Ignoradas' },
];

export function normalizeSignal(raw = {}, i = 0) {
  const decision = String(raw.decision || '').toLowerCase();
  return {
    id: raw.id ?? `s${i}`,
    botId: pick(raw, 'strategyId', 'strategy_id', 'botId') ?? null,
    alertId: pick(raw, 'alertId', 'alert_id') ?? null,
    alertName: pick(raw, 'alertName', 'alert_name') || '—',
    direction: normalizeDirection(raw.direction),
    asset: raw.asset || '',
    score: toNumber(raw.score),
    decision,
    decisionLabel: DECISION_LABEL[decision] || decision || '—',
    tone: DECISION_TONE[decision] || 'skip',
    detail: raw.detail || '',
    at: toMs(pick(raw, 'createdAt', 'created_at', 'at', 't')),
  };
}

export function normalizeSignals(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeSignal)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// Defensa en el cliente por si el servidor ignora `filter`.
export function filterSignals(signals, filter) {
  if (filter === 'traded') return signals.filter(isTraded);
  if (filter === 'ignored') return signals.filter((s) => !isTraded(s));
  return signals;
}

export const formatScore = (score) => (score === null || score === undefined ? '—' : formatPct(score, { decimals: 0 }));

// Señal más reciente entre todos los bots (tarjeta «Última señal» del móvil).
export function latestSignal(bots) {
  let best = null;
  for (const b of bots || []) {
    const s = b.lastSignal;
    if (!s) continue;
    if (!best || (s.at ?? 0) > (best.signal.at ?? 0)) best = { bot: b, signal: s };
  }
  return best;
}

// ── KPIs ──────────────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const usdtSigned = (v) => (Number.isFinite(v) ? formatUsdt(v, { sign: true }) : '—');
const toneOfPnl = (v) => (!Number.isFinite(v) || v === 0 ? 'neutral' : v > 0 ? 'pos' : 'neg');

export function signalStats(signals, now = Date.now()) {
  const recent = (signals || []).filter((s) => s.at === null || now - s.at <= 30 * DAY_MS);
  return {
    total: recent.length,
    bullish: recent.filter((s) => s.direction === 'bullish').length,
    bearish: recent.filter((s) => s.direction === 'bearish').length,
    traded: recent.filter(isTraded).length,
  };
}

// El detalle (GET /options/strategies/:id) trae los KPIs por libro:
// { shadow: { pnl30dUsdt, cycles, winRatePct }, live: {...} }.
export function buildBotKpis(bot, stats) {
  const k = bot?.kpis && typeof bot.kpis === 'object' && !Array.isArray(bot.kpis) ? bot.kpis : {};
  const shadow = k.shadow && typeof k.shadow === 'object' ? k.shadow : {};
  const live = k.live && typeof k.live === 'object' ? k.live : {};
  const pnlShadow = toNumber(shadow.pnl30dUsdt) ?? bot?.pnlShadow ?? null;
  const pnlLive = toNumber(live.pnl30dUsdt) ?? bot?.pnlLive ?? null;
  const active = bot?.mode === 'live' ? live : shadow;
  const cycles = toNumber(active.cycles);
  const winRate = toNumber(active.winRatePct);
  const wins = cycles !== null && winRate !== null ? Math.round((cycles * winRate) / 100) : null;
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
      value: wins !== null ? `${wins} / ${cycles}` : formatPct(winRate, { decimals: 0 }),
      tone: 'neutral',
      hint: 'operaciones ganadoras',
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
      underlying: bot.underlying || underlying,
      alertIds: [...(bot.alertIds || [])],
      structure,
      targetDelta: Math.abs(val('targetDelta')),
      expiryDays: val('expiryDays'),
      quantity: val('quantity'),
      onOpposite: ON_OPPOSITE.some((o) => o.value === p.onOpposite) ? p.onOpposite : defs.onOpposite,
      takeProfitPct: val('takeProfitPct'),
      stopLossPct: val('stopLossPct'),
      exitHoursBeforeExpiry: val('exitHoursBeforeExpiry'),
      maxOpenPositions: val('maxOpenPositions'),
      maxTradesPerDay: val('maxTradesPerDay'),
      maxPremiumUsdt: structure === 'buy_with' ? (toNumber(p.maxPremiumUsdt) ?? null) : defs.maxPremiumUsdt,
      maxMarginUsdt: structure === 'sell_against' ? (toNumber(bot.limits?.maxMarginUsdt) ?? null) : null,
    };
  }
  return {
    name: '',
    underlying,
    alertIds: [],
    structure: 'buy_with',
    ...COMMON_DEFAULTS,
    ...STRUCTURE_DEFAULTS.buy_with,
  };
}

// Cambiar de estructura aplica sus valores por defecto (delta, salidas y riesgo).
export function withStructure(form, structure) {
  const s = normalizeStructure(structure);
  return { ...form, structure: s, ...STRUCTURE_DEFAULTS[s] };
}

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

export function validateBotForm(form) {
  const errors = {};
  const name = String(form.name || '').trim();
  if (!name) errors.name = 'Ponle un nombre';
  else if (name.length > NAME_MAX) errors.name = `Máximo ${NAME_MAX} caracteres`;
  if (!form.underlying) errors.underlying = 'Elige un subyacente';
  if (!form.alertIds?.length) errors.alertIds = 'Elige al menos una alerta';
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
  range('quantity', 0.0001, 1000000, { minLabel: 'Debe ser mayor que 0' });
  range('takeProfitPct', 1, 1000);
  range('stopLossPct', 1, 1000);
  range('exitHoursBeforeExpiry', 0, 168);
  range('maxOpenPositions', 1, 20, { integer: true });
  range('maxTradesPerDay', 1, 100, { integer: true });
  const riskKey = form.structure === 'sell_against' ? 'maxMarginUsdt' : 'maxPremiumUsdt';
  if (isNum(form[riskKey]) && Number(form[riskKey]) < 0) errors[riskKey] = 'No puede ser negativo';
  return errors;
}

// POST /options/auto-bots: { name, underlying, alertIds, params, limits? }.
// PUT /:id no admite cambiar el subyacente.
export function buildBotPayload(form, { editing = false, baseLimits = {} } = {}) {
  const buy = form.structure === 'buy_with';
  const params = {
    structure: form.structure,
    targetDelta: Number(form.targetDelta),
    expiryDays: Number(form.expiryDays),
    quantity: Number(form.quantity),
    onOpposite: form.onOpposite,
    takeProfitPct: Number(form.takeProfitPct),
    stopLossPct: Number(form.stopLossPct),
    exitHoursBeforeExpiry: Number(form.exitHoursBeforeExpiry),
    maxOpenPositions: Number(form.maxOpenPositions),
    maxTradesPerDay: Number(form.maxTradesPerDay),
  };
  if (buy && Number(form.maxPremiumUsdt) > 0) params.maxPremiumUsdt = Number(form.maxPremiumUsdt);
  // 0 o vacío = sin margen propio (sólo el límite global).
  const limits = { ...(baseLimits || {}) };
  if (!buy && Number(form.maxMarginUsdt) > 0) limits.maxMarginUsdt = Number(form.maxMarginUsdt);
  else delete limits.maxMarginUsdt;

  const payload = {
    name: String(form.name).trim(),
    alertIds: [...form.alertIds],
    params,
    limits,
  };
  if (!editing) payload.underlying = form.underlying;
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
  return {
    entry: [
      { key: 'targetDelta', label: 'Delta objetivo', value: formatNumber(Math.abs(v('targetDelta')), { decimals: 2 }) },
      { key: 'expiryDays', label: 'Vencimiento', value: `${formatNumber(v('expiryDays'), { decimals: 0 })} días` },
      { key: 'quantity', label: 'Cantidad', value: `${formatNumber(v('quantity'), { decimals: 4, minDecimals: 0 })} ${bot.underlying || ''}`.trim() },
      { key: 'onOpposite', label: 'Señal contraria', value: opposite.help, text: true },
    ],
    exits: [
      { key: 'takeProfitPct', label: labels.takeProfit, value: `${buy ? '+' : ''}${formatNumber(v('takeProfitPct'), { decimals: 0 })} % de la prima` },
      { key: 'stopLossPct', label: labels.stopLoss, value: `${buy ? '−' : ''}${formatNumber(v('stopLossPct'), { decimals: 0 })} % de la prima` },
      { key: 'exitHoursBeforeExpiry', label: 'Cerrar antes del venc.', value: `${formatNumber(v('exitHoursBeforeExpiry'), { decimals: 0 })} h` },
    ],
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

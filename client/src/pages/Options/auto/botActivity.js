// Vistas puras del detalle de un bot: posiciones abiertas, órdenes vivas,
// uso de límites y operaciones cerradas. Sin acceso a red ni al reloj salvo
// el parámetro `now` (para poder probarlas).
import { formatNumber, toMs, toNumber, tone } from '../strategies/common/format';
import { entryProgress, formatCountdown, ladder, signalFeeText } from './botView';

export const REASON_LABEL = {
  take_profit: 'Toma de ganancia',
  take_profit_volatility: 'TP por volatilidad',
  take_profit_atr_band: 'TP banda ATR',
  stop_loss: 'Stop',
  time_exit: 'Por tiempo',
  max_hold_exit: 'Tiempo máximo',
  opposite_signal: 'Señal contraria',
  expiry: 'Vencimiento',
  manual: 'Manual',
};

const isSell = (side) => String(side || '').toUpperCase() === 'SELL';
const sideLabel = (side) => (isSell(side) ? 'Vender' : String(side || '').toUpperCase() === 'BUY' ? 'Comprar' : '—');
const round = (n) => Math.round(n * 1e8) / 1e8;
const list = (v) => (Array.isArray(v) ? v : []);

// Suma de las comisiones conocidas de una posición; null si no hay ninguna.
function positionFees(p) {
  const parts = [p.entryFeeUsdt, p.exitFeeUsdt, p.exerciseFeeUsdt].map(toNumber).filter((n) => n !== null);
  return parts.length ? round(parts.reduce((a, b) => a + b, 0)) : null;
}

// Vencimiento de Binance: 08:00 UTC del día YYMMDD del símbolo.
function expiryMs(symbol) {
  const m = /-(\d{2})(\d{2})(\d{2})-/.exec(symbol || '');
  return m ? Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), 8) : null;
}

// Desglose del objetivo fijado al llenarse (tp_target_meta).
export function atrBandBreakdown(p) {
  const m = p.tpTargetMeta;
  const target = toNumber(p.tpTargetPrice);
  if (!m || target === null) return 'Calculando objetivo…';
  const n = (v, d = 2) => formatNumber(v, { decimals: d, minDecimals: 0 });
  const text = `Spot ${n(m.spot)} → banda ${n(m.bandValue)} (${formatNumber(m.distancePct, { decimals: 1, sign: true })} %) × apal. ${n(m.leverage, 1)}× = ${formatNumber(m.appliedGainPct, { decimals: 0, sign: true })} % → venta a ${formatNumber(target, { decimals: 2, minDecimals: 1 })} USDT`;
  return m.capped ? `${text} (tope)` : text;
}

// Objetivo de TP que no depende del mercado: el fijado al llenarse (banda
// ATR) o el porcentaje de la configuración. compra: entry·(1+tp); venta
// (recompra): entry·(1−tp). null en modo volatilidad o sin datos.
function fixedTpPrice(p, params = {}) {
  if (params.takeProfitMode === 'atr_band') return toNumber(p.tpTargetPrice);
  if (params.takeProfitMode === 'volatility') return null;
  const entry = toNumber(p.entryPrice);
  const tpPct = toNumber(params.takeProfitPct);
  if (entry === null || tpPct === null) return null;
  return round(entry * (isSell(p.side) ? 1 - tpPct / 100 : 1 + tpPct / 100));
}

export function openPositionRows(detail = {}, mode = 'shadow', now = Date.now()) {
  const params = detail.params || {};
  const slPct = toNumber(params.stopLossPct);
  const volatility = params.takeProfitMode === 'volatility';
  const atrBand = params.takeProfitMode === 'atr_band';
  return list(detail.positions)
    .filter((p) => p.closedAt == null && (p.mode || 'shadow') === mode)
    .map((p) => {
      const sell = isSell(p.side);
      const entry = toNumber(p.entryPrice);
      const qty = toNumber(p.quantity);
      const mark = toNumber(p.mark);
      const dir = sell ? -1 : 1;
      const tpPrice = volatility ? toNumber(p.takeProfitTarget?.price) : fixedTpPrice(p, params);
      const stopPrice = !atrBand && entry !== null && slPct !== null ? round(entry * (sell ? 1 + slPct / 100 : 1 - slPct / 100)) : null;
      const pnlUsdt = mark !== null && entry !== null && qty !== null ? round((mark - entry) * dir * qty) : null;
      const pnlPct = mark !== null && entry ? ((mark - entry) * dir / entry) * 100 : null;
      const exp = expiryMs(p.symbol);
      return {
        id: p.id,
        symbol: p.symbol,
        sideLabel: sideLabel(p.side),
        quantity: qty,
        entry,
        // Prima total: pagada al comprar, cobrada al vender.
        premiumUsdt: entry !== null && qty !== null ? round(entry * qty) : null,
        openedAt: p.openedAt ?? null,
        mark,
        pnlUsdt,
        pnlPct,
        tpPrice,
        // Incremento del TP sobre la entrada (negativo al vender: recompra más barata).
        tpPct: tpPrice !== null && entry ? ((tpPrice - entry) / entry) * 100 : null,
        stopPrice,
        tpBreakdown: atrBand ? atrBandBreakdown(p) : null,
        hoursToExpiry: exp === null ? null : Math.max(0, Math.round((exp - now) / 3600000)),
        expiresAt: exp,
        feesUsdt: positionFees(p),
        tone: tone(pnlUsdt),
      };
    });
}

const STATUS_LABEL = {
  queued: 'En cola',
  submitted: 'Enviada',
  partial: 'Parcial',
  attention: 'Requiere atención',
  cancelling: 'Cancelando',
};

function expiresIn(deadlineAt, now) {
  const ms = toNumber(deadlineAt);
  if (ms === null) return null;
  const diff = ms - now;
  if (diff <= 0) return 'vencida';
  const min = Math.round(diff / 60000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.round(diff / 3600000);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export function pendingOrderRows(detail = {}, now = Date.now()) {
  return list(detail.pendingOrders).map((o) => {
    const attention = o.status === 'attention';
    return {
      id: o.id,
      kindLabel: o.purpose === 'take_profit' ? 'TP residente' : o.action === 'open' ? 'Entrada' : 'Salida',
      symbol: o.symbol,
      sideLabel: sideLabel(o.side),
      price: toNumber(o.price),
      filled: `${formatNumber(o.executedQty ?? 0, { decimals: 4, minDecimals: 0 })} / ${formatNumber(o.quantity, { decimals: 4, minDecimals: 0 })}`,
      status: STATUS_LABEL[o.status] || o.status || '—',
      statusTone: attention ? 'neg' : 'neutral',
      expiresIn: expiresIn(o.deadlineAt, now),
      needsAttention: attention,
      // Solo se cancelan entradas: las salidas se reintentan solas y el TP
      // residente se cancela cerrando la posición.
      cancelRequested: o.cancelRequested === true,
      cancellable: o.action === 'open' && o.purpose !== 'take_profit' && o.cancelRequested !== true,
    };
  });
}

function usageRow(label, used, max) {
  const m = toNumber(max);
  const u = toNumber(used) ?? 0;
  return { label, used: u, max: m, pct: m === null || m <= 0 ? null : Math.min(100, Math.max(0, (u / m) * 100)) };
}

export function usageRows(bot = {}) {
  const params = bot.params || {};
  const limits = bot.limits || {};
  const usage = bot.usage || {};
  const mode = bot.mode === 'live' ? 'live' : 'shadow';
  const open = list(bot.positions).filter((p) => p.closedAt == null && (p.mode || 'shadow') === mode).length;
  return [
    usageRow('Posiciones abiertas', open, params.maxOpenPositions),
    usageRow('Operaciones de hoy', usage.ordersToday, params.maxTradesPerDay),
    usageRow('Margen usado', usage.marginUsedUsdt, limits.maxMarginUsdt),
    usageRow('Pérdida del día', usage.dailyLossUsdt, limits.maxDailyLossUsdt),
    ...(toNumber(params.budgetUsdt) > 0 ? [committedRow(usage.committedUsdt, params.budgetUsdt)] : []),
  ];
}

// Presupuesto total del bot: posiciones abiertas + entradas pendientes (Real).
function committedRow(committed, budget) {
  const row = usageRow('Comprometido', committed, budget);
  const fmt = (n) => formatNumber(n, { decimals: 2, minDecimals: 0 });
  return { ...row, text: `${fmt(row.used)} de ${fmt(row.max)} USDT` };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Tiempo transcurrido legible: «< 1 min», «45 min», «2 h 15 min», «1 día 4 h».
export function formatElapsed(ms) {
  const n = toNumber(ms);
  if (n === null || n < 0) return '—';
  if (n < MINUTE_MS) return '< 1 min';
  if (n < HOUR_MS) return `${Math.floor(n / MINUTE_MS)} min`;
  if (n < DAY_MS) {
    const h = Math.floor(n / HOUR_MS);
    const m = Math.floor((n % HOUR_MS) / MINUTE_MS);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(n / DAY_MS);
  const h = Math.floor((n % DAY_MS) / HOUR_MS);
  const days = `${d} ${d === 1 ? 'día' : 'días'}`;
  return h ? `${days} ${h} h` : days;
}

// Un extremo de la prima: precio, variación sobre la entrada y cuánto tardó
// desde la apertura. Al vender, una prima más alta es una pérdida.
function premiumPoint(point, p) {
  const price = toNumber(point?.price);
  if (price === null) return null;
  const at = toMs(point.at);
  const openedAt = toMs(p.openedAt);
  const entry = toNumber(p.entryPrice);
  const changePct = entry > 0 ? (price / entry - 1) * 100 : null;
  const afterMs = at !== null && openedAt !== null ? Math.max(0, at - openedAt) : null;
  return {
    price,
    at,
    changePct,
    afterMs,
    afterText: formatElapsed(afterMs),
    tone: tone(changePct === null ? null : isSell(p.side) ? -changePct : changePct),
  };
}

function premiumRangeView(p) {
  const r = p.premiumRange;
  if (!r) return null;
  const high = premiumPoint(r.high, p);
  const low = premiumPoint(r.low, p);
  if (!high || !low) return null;
  return { high, low, partial: !!r.partial, sell: isSell(p.side) };
}

// Objetivo de una operación cerrada y si la prima llegó a tocarlo (máximo al
// comprar, mínimo al vender); reached null sin rango de prima. El objetivo
// por porcentaje se deriva de la configuración actual del bot.
function closedTargetView(p, params, premium) {
  const price = fixedTpPrice(p, params);
  if (price === null) return null;
  const entry = toNumber(p.entryPrice);
  const sell = isSell(p.side);
  const atrBand = params.takeProfitMode === 'atr_band';
  let reached = null;
  if (premium) reached = sell ? premium.low.price <= price : premium.high.price >= price;
  return {
    price,
    pct: entry ? ((price - entry) / entry) * 100 : null,
    breakdown: atrBand && p.tpTargetMeta ? atrBandBreakdown(p) : null,
    fromParams: !atrBand,
    reached,
  };
}

export function closedTradeRows(detail = {}, mode = 'shadow') {
  const params = detail.params || {};
  return list(detail.closedPositions)
    .filter((p) => (p.mode || 'shadow') === mode)
    .map((p) => {
      const premium = premiumRangeView(p);
      return {
        id: p.id,
        symbol: p.symbol,
        openedAt: p.openedAt ?? null,
        closedAt: p.closedAt ?? null,
        entry: toNumber(p.entryPrice),
        exit: toNumber(p.exitPrice),
        pnlUsdt: toNumber(p.pnlUsdt),
        reasonLabel: REASON_LABEL[p.closeReason] || '—',
        feesUsdt: positionFees(p),
        premium,
        target: closedTargetView(p, params, premium),
      };
    });
}

// Entradas GTC al medio en espera (sombra y real), con cuenta atrás.
export function pendingEntryRows(detail = {}, now = Date.now()) {
  return list(detail.pendingEntries).map((e) => {
    const deadlineAt = toMs(e.deadlineAt);
    const remainingMs = deadlineAt === null ? 0 : Math.max(0, deadlineAt - now);
    const n = (v) => formatNumber(v ?? 0, { decimals: 4, minDecimals: 0 });
    return {
      id: e.id,
      mode: e.mode || 'shadow',
      symbol: e.symbol,
      sideLabel: sideLabel(e.side),
      quantity: toNumber(e.quantity),
      limitPrice: toNumber(e.limitPrice),
      bid: toNumber(e.bid),
      ask: toNumber(e.ask),
      deadlineAt,
      remainingMs,
      countdown: formatCountdown(remainingMs),
      progress: entryProgress(remainingMs),
      filled: `${n(e.executedQty)} de ${n(e.quantity)}`,
      ladder: ladder(e),
      feeText: signalFeeText({ feesUsdt: e.feesEstUsdt, feesEstimated: true }),
    };
  });
}

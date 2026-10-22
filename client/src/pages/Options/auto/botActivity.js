// Vistas puras del detalle de un bot: posiciones abiertas, órdenes vivas,
// uso de límites y operaciones cerradas. Sin acceso a red ni al reloj salvo
// el parámetro `now` (para poder probarlas).
import { formatNumber, toNumber, tone } from '../strategies/common/format';

export const REASON_LABEL = {
  take_profit: 'Toma de ganancia',
  take_profit_volatility: 'TP por volatilidad',
  take_profit_atr_band: 'TP banda ATR',
  stop_loss: 'Stop',
  time_exit: 'Por tiempo',
  opposite_signal: 'Señal contraria',
  expiry: 'Vencimiento',
  manual: 'Manual',
};

const isSell = (side) => String(side || '').toUpperCase() === 'SELL';
const sideLabel = (side) => (isSell(side) ? 'Vender' : String(side || '').toUpperCase() === 'BUY' ? 'Comprar' : '—');
const round = (n) => Math.round(n * 1e8) / 1e8;
const list = (v) => (Array.isArray(v) ? v : []);

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

export function openPositionRows(detail = {}, mode = 'shadow', now = Date.now()) {
  const params = detail.params || {};
  const tpPct = toNumber(params.takeProfitPct);
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
      let tpPrice = null;
      if (atrBand) tpPrice = toNumber(p.tpTargetPrice);
      else if (volatility) tpPrice = toNumber(p.takeProfitTarget?.price);
      // compra: entry·(1+tp); venta (recompra): entry·(1−tp)
      else if (entry !== null && tpPct !== null) tpPrice = round(entry * (sell ? 1 - tpPct / 100 : 1 + tpPct / 100));
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
        mark,
        pnlUsdt,
        pnlPct,
        tpPrice,
        stopPrice,
        tpBreakdown: atrBand ? atrBandBreakdown(p) : null,
        hoursToExpiry: exp === null ? null : Math.max(0, Math.round((exp - now) / 3600000)),
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

export function closedTradeRows(detail = {}, mode = 'shadow') {
  return list(detail.closedPositions)
    .filter((p) => (p.mode || 'shadow') === mode)
    .map((p) => ({
      id: p.id,
      symbol: p.symbol,
      openedAt: p.openedAt ?? null,
      closedAt: p.closedAt ?? null,
      entry: toNumber(p.entryPrice),
      exit: toNumber(p.exitPrice),
      pnlUsdt: toNumber(p.pnlUsdt),
      reasonLabel: REASON_LABEL[p.closeReason] || '—',
    }));
}

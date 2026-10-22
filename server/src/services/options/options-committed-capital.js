/**
 * Capital comprometido de una estrategia (presupuesto total de los bots por
 * alertas). Puro: lo comparten el runner (contexto de `evaluate`), el
 * backtest y el detalle de la estrategia («Uso de límites»).
 *
 * - Posición abierta comprada: la prima pagada (entryPrice × quantity).
 * - Posición abierta vendida: el margen estimado (`estimateMargin`).
 * - Orden de entrada no final (solo Real): lo que falta por ejecutar,
 *   (quantity − processedQty) al precio LIMIT; si es una venta, como margen
 *   estimado. Lo ya ejecutado ya es una posición; lo cancelado libera reserva.
 */

const { parseSymbol } = require('./options-utils');

/**
 * Margen estimado de una pata (USDT). Vendida: prima + máx(15 % del spot −
 * lo que esté OTM, 10 % del spot), por unidad. Comprada: la prima pagada.
 */
function estimateMargin({ side, type, strike, price, quantity, spot }) {
  const qty = Number(quantity);
  if (side === 'BUY') return Number(price) * qty;
  // Sin spot el margen de una venta es desconocido: NaN obliga a bloquear
  // en vez de quedarse solo con la prima.
  if (!(Number(spot) > 0)) return NaN;
  const otm = type === 'C' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  return qty * (Number(price) + Math.max(0.15 * spot - otm, 0.1 * spot));
}

function legCommitted({ symbol, side, type, strike, price, quantity }, spot) {
  const meta = type && strike != null ? { type, strike } : parseSymbol(symbol) || {};
  return estimateMargin({ side, type: meta.type, strike: meta.strike, price, quantity, spot });
}

/** Comprometido por una posición abierta (prima o margen estimado). */
function positionCommittedUsdt(position, spot) {
  return legCommitted({ ...position, price: position.entryPrice }, spot);
}

/** Reserva de una orden de entrada no final: lo pendiente al precio LIMIT. */
function orderReservedUsdt(order, spot) {
  if (order.action !== 'open' || order.status === 'final') return 0;
  const remaining = Math.max(0, Number(order.quantity) - Number(order.processedQty || 0));
  if (!(remaining > 0)) return 0;
  return legCommitted({ symbol: order.symbol, side: order.side, price: order.limitPrice, quantity: remaining }, spot);
}

/**
 * Total comprometido: posiciones abiertas + órdenes de entrada pendientes.
 * NaN si una venta no puede valorarse (sin spot): el template bloquea.
 * `spots` (opcional, `{ BTC: 60000, ETH: 3000 }`): spot por subyacente del
 * símbolo, para bots con varios; lo que no esté usa `spot`.
 */
function committedUsdt({ positions = [], orders = [], spot, spots = null }) {
  const spotOf = (symbol) => {
    const underlying = spots ? parseSymbol(symbol)?.underlying : null;
    return underlying && underlying in spots ? spots[underlying] : spot;
  };
  let total = 0;
  for (const p of positions) total += positionCommittedUsdt(p, spotOf(p.symbol));
  for (const o of orders) total += orderReservedUsdt(o, spotOf(o.symbol));
  return total;
}

module.exports = { estimateMargin, positionCommittedUsdt, orderReservedUsdt, committedUsdt };

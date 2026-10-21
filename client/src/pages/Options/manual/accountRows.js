// Normalización defensiva de las filas de cuenta (posiciones, órdenes y
// ejecuciones), para no depender de los nombres exactos de Binance.
import { isLongPosition } from './hooks/useOrderActions';

export function sideLabel(side) {
  const s = String(side || '').toUpperCase();
  return s === 'BUY' || s === 'LONG' ? 'Compra' : 'Venta';
}

export function positionView(p) {
  const long = isLongPosition(p);
  const quantity = Math.abs(Number(p.quantity));
  const mark = p.markPrice == null || p.markPrice === '' ? null : Number(p.markPrice);
  const premiumCurrent = Number.isFinite(mark) && mark >= 0 && Number.isFinite(quantity)
    ? mark * quantity : null;
  return {
    key: p.symbol,
    symbol: p.symbol,
    long,
    side: long ? 'Compra' : 'Venta',
    qty: quantity,
    entry: p.entryPrice,
    mark: p.markPrice,
    premiumCurrent,
    pnl: p.unrealizedPnl,
    delta: p.delta,
    theta: p.theta,
    origin: !p.origin || p.origin === 'manual' ? 'Manual' : p.origin,
  };
}

export function orderView(o) {
  return {
    key: `${o.symbol}-${o.orderId}`,
    orderId: o.orderId,
    symbol: o.symbol,
    side: String(o.side || '').toUpperCase(),
    price: o.price,
    qty: o.quantity ?? o.origQty,
    filled: o.executedQty ?? 0,
    created: o.createdAt ?? o.createTime ?? o.createDate ?? o.time,
  };
}

export function tradeView(t, i) {
  const price = Number(t.price);
  const qty = Math.abs(Number(t.quantity ?? t.qty));
  // Prima total de la ejecución (precio × contratos): pagada en compras, cobrada en ventas.
  const premiumTotal = t.price != null && t.price !== '' && Number.isFinite(price) && Number.isFinite(qty)
    ? price * qty : null;
  return {
    key: t.id ?? t.tradeId ?? `${t.symbol}-${t.time}-${i}`,
    symbol: t.symbol,
    side: String(t.side || '').toUpperCase(),
    price: t.price,
    qty: t.quantity ?? t.qty,
    fee: t.fee,
    premiumTotal,
    pnl: t.realizedProfit ?? t.realizedPnl,
    time: t.time ?? t.tradeTime,
  };
}

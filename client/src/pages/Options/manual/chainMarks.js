// Distintivos de la cadena: qué contratos tienen posición abierta (★) u
// órdenes pendientes (▲ compra / ▼ venta), agrupados por símbolo y por
// vencimiento para marcar la matriz y las pastillas de fecha.
import { fmtNum, fmtPrice, fmtSigned } from '../format';
import { orderView, positionView } from './accountRows';

const EMPTY = { bySymbol: new Map(), byExpiry: new Map() };

// BTC-261023-81000-C → '261023'.
export function expiryOfSymbol(symbol) {
  const code = String(symbol || '').split('-')[1];
  return /^\d{6}$/.test(code || '') ? code : null;
}

function entryFor(map, symbol) {
  let e = map.get(symbol);
  if (!e) { e = { position: null, orders: [] }; map.set(symbol, e); }
  return e;
}

function bump(map, code, key) {
  if (!code) return;
  const e = map.get(code) || { positions: 0, orders: 0 };
  e[key] += 1;
  map.set(code, e);
}

export function buildChainMarks(positions = [], openOrders = []) {
  if (!positions.length && !openOrders.length) return EMPTY;
  const bySymbol = new Map();
  const byExpiry = new Map();
  for (const raw of positions) {
    const p = positionView(raw);
    if (!p.symbol || !(Number(p.qty) > 0)) continue;
    entryFor(bySymbol, p.symbol).position = { long: p.long, qty: p.qty, entry: p.entry, pnl: p.pnl };
    bump(byExpiry, expiryOfSymbol(p.symbol), 'positions');
  }
  for (const raw of openOrders) {
    const o = orderView(raw);
    if (!o.symbol) continue;
    const left = Number(o.qty) - Number(o.filled || 0);
    entryFor(bySymbol, o.symbol).orders.push({
      buy: o.side === 'BUY',
      qty: Number.isFinite(left) && left > 0 ? left : o.qty,
      price: o.price,
    });
    bump(byExpiry, expiryOfSymbol(o.symbol), 'orders');
  }
  return { bySymbol, byExpiry };
}

export function positionText(pos) {
  return `${pos.long ? 'Compra' : 'Venta'} ${fmtNum(pos.qty, 2)}`;
}

export function positionTip(pos) {
  const pnl = pos.pnl == null ? '' : ` · P&L ${fmtSigned(pos.pnl, 2)}`;
  return `Posición abierta: ${positionText(pos).toLowerCase()} · entrada ${fmtPrice(pos.entry)}${pnl}`;
}

export function orderTip(o) {
  return `Orden de ${o.buy ? 'compra' : 'venta'} ${fmtNum(o.qty, 2)} a ${fmtPrice(o.price)}`;
}

// Versión corta para la fila móvil (columna de ~80 px): cantidad con
// signo (+ compra, − venta) o el precio de la orden.
export function markShort(mark) {
  if (!mark) return null;
  if (mark.position) return fmtSigned(mark.position.long ? mark.position.qty : -mark.position.qty, 2);
  if (mark.orders.length === 1) return `@ ${fmtPrice(mark.orders[0].price)}`;
  if (mark.orders.length > 1) return `${mark.orders.length} órd.`;
  return null;
}

export function markAria(mark) {
  if (!mark) return '';
  const parts = [];
  if (mark.position) parts.push(positionTip(mark.position));
  for (const o of mark.orders) parts.push(orderTip(o));
  return parts.length ? `, ${parts.join(', ')}` : '';
}

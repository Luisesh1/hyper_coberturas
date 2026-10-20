/**
 * options-account.service.js
 *
 * Lectura y normalización de la cuenta de Binance Opciones (cuenta,
 * posiciones y órdenes abiertas). Lo comparten las rutas REST y el stream
 * en tiempo real (`options-account-stream.service`) para que ambos
 * entreguen exactamente la misma forma.
 */

const db = require('../../db');
const logger = require('../logger.service');
const optionsMarket = require('./options-market.service');

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOrder(o = {}) {
  return {
    orderId: o.orderId != null ? String(o.orderId) : null,
    clientOrderId: o.clientOrderId || null,
    symbol: o.symbol,
    side: o.side,
    type: o.type || 'LIMIT',
    price: num(o.price),
    quantity: num(o.quantity),
    executedQty: num(o.executedQty),
    avgPrice: num(o.avgPrice),
    fee: num(o.fee),
    status: o.status || null,
    timeInForce: o.timeInForce || null,
    postOnly: o.postOnly === true || o.postOnly === 'true',
    reduceOnly: o.reduceOnly === true || o.reduceOnly === 'true',
    createdAt: num(o.createTime),
    updatedAt: num(o.updateTime),
  };
}

/**
 * Mapa símbolo → nombre de la estrategia dueña de una posición real abierta.
 * La tabla `options_strategy_positions` la crea otra migración (031); si aún
 * no existe, todas las posiciones son manuales.
 */
async function loadPositionOrigins(userId) {
  try {
    const { rows } = await db.query(
      `SELECT p.symbol, s.name
         FROM options_strategy_positions p
         JOIN options_strategies s ON s.id = p.strategy_id
        WHERE p.user_id = $1 AND p.mode = 'live' AND p.closed_at IS NULL`,
      [userId]
    );
    const map = new Map();
    for (const row of rows) if (!map.has(row.symbol)) map.set(row.symbol, row.name);
    return map;
  } catch (err) {
    if (err?.code !== '42P01') {
      logger.warn('options_position_origins_failed', { userId, error: err.message });
    }
    return new Map();
  }
}

function formatAccount(account) {
  const assets = Array.isArray(account?.asset) ? account.asset : [];
  // Nunca etiquetar el saldo de otro activo como USDT, ni inventar 0
  // cuando Binance omite datos de margen de la cuenta de opciones.
  const usdt = assets.find((a) => a.asset === 'USDT') || null;
  const equity = usdt ? (num(usdt.equity) ?? num(usdt.marginBalance)) : null;
  const available = num(usdt?.available);
  const initialMargin = num(usdt?.initialMargin);
  const marginUsedUsdt = initialMargin != null
    ? initialMargin
    : (available != null && equity != null
      ? Math.max(0, equity - available)
      : num(usdt?.locked));

  const greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const g of Array.isArray(account?.greek) ? account.greek : []) {
    for (const key of Object.keys(greeks)) greeks[key] += num(g[key]) ?? 0;
  }

  return {
    balanceUsdt: equity,
    marginUsedUsdt,
    unrealizedPnlUsdt: num(usdt?.unrealizedPNL) ?? 0,
    greeks,
  };
}

function formatPositions(positions, marks, origins) {
  const markMap = new Map((Array.isArray(marks) ? marks : []).map((m) => [m.symbol, m]));
  return (Array.isArray(positions) ? positions : []).map((p) => {
    const rawQty = num(p.quantity) ?? 0;
    const side = p.side === 'SHORT' || rawQty < 0 ? 'SHORT' : 'LONG';
    const quantity = Math.abs(rawQty);
    const sign = side === 'SHORT' ? -1 : 1;
    const mark = markMap.get(p.symbol);
    const delta = num(mark?.delta);
    const theta = num(mark?.theta);
    return {
      symbol: p.symbol,
      side,
      quantity,
      entryPrice: num(p.entryPrice),
      markPrice: num(p.markPrice) ?? num(mark?.markPrice),
      unrealizedPnl: num(p.unrealizedPNL),
      delta: delta != null ? delta * quantity * sign : null,
      theta: theta != null ? theta * quantity * sign : null,
      origin: origins.get(p.symbol) || 'manual',
    };
  });
}

async function loadAccount(client) {
  return formatAccount(await client.getAccount());
}

async function loadPositions(client, userId) {
  const [positions, marks, origins] = await Promise.all([
    client.getPositions(),
    optionsMarket.getMarks().catch(() => []),
    loadPositionOrigins(userId),
  ]);
  return formatPositions(positions, marks, origins);
}

async function loadOpenOrders(client) {
  const orders = await client.getOpenOrders();
  return (Array.isArray(orders) ? orders : []).map(normalizeOrder);
}

/** Cuenta, posiciones y órdenes abiertas en un único snapshot. */
async function loadSnapshot(client, userId) {
  const [account, positions, openOrders] = await Promise.all([
    loadAccount(client),
    loadPositions(client, userId),
    loadOpenOrders(client),
  ]);
  return { account, positions, openOrders };
}

module.exports = {
  num,
  normalizeOrder,
  loadPositionOrigins,
  formatAccount,
  formatPositions,
  loadAccount,
  loadPositions,
  loadOpenOrders,
  loadSnapshot,
};

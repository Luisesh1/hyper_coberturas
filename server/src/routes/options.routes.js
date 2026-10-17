/**
 * options.routes.js
 *
 * Opciones europeas de Binance — mercado y trading manual.
 *
 * GET    /api/options/underlyings                 → subyacentes con spot y cambio 24h
 * GET    /api/options/chain?underlying=&expiry=   → cadena con griegas (YYMMDD)
 * GET    /api/options/account                     → balance, margen, PnL y griegas
 * GET    /api/options/positions                   → posiciones abiertas (origen manual/estrategia)
 * GET    /api/options/orders/open                 → órdenes abiertas
 * POST   /api/options/orders                      → orden LIMIT (GTC)
 * DELETE /api/options/orders/:symbol/:orderId     → cancela una orden
 * GET    /api/options/trades?days=30              → historial de operaciones
 */

const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate, requireSuperuser } = require('../middleware/auth.middleware');
const { ValidationError } = require('../errors/app-error');
const db = require('../db');
const logger = require('../services/logger.service');
const optionsMarket = require('../services/options/options-market.service');
const optionsCredentials = require('../services/options/options-credentials.service');

const router = Router();
router.use(authenticate);

const SYMBOL_REGEX = /^[A-Z0-9]{2,10}-\d{6}-\d+(?:\.\d+)?-[CP]$/;
const ORDER_ID_REGEX = /^\d{1,20}$/;
const CLIENT_ORDER_ID_REGEX = /^[A-Za-z0-9_-]{1,36}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRADE_DAYS = 90;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseSymbolParam(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!SYMBOL_REGEX.test(symbol)) {
    throw new ValidationError('symbol inválido (formato BTC-261031-68000-C)');
  }
  return symbol;
}

function parsePositive(value, field) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`${field} debe ser un número positivo`);
  }
  return n;
}

function parseOptionalBoolean(value, field) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new ValidationError(`${field} debe ser booleano`);
  return value;
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

function normalizeTrade(t = {}) {
  return {
    id: t.id != null ? String(t.id) : null,
    tradeId: t.tradeId != null ? String(t.tradeId) : null,
    orderId: t.orderId != null ? String(t.orderId) : null,
    symbol: t.symbol,
    side: t.side,
    price: num(t.price),
    quantity: num(t.quantity),
    fee: num(t.fee),
    realizedPnl: num(t.realizedProfit),
    liquidity: t.liquidity || null,
    time: num(t.time),
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

// Diagnostico GTC privado: solo usuarios superuser de la cuenta piloto #1.
// Recalcula filtros/cuenta reales mediante GETs de Binance; NO crea/cancela
// ordenes, no escribe DB, no activa flags y siempre responde pilotReady=false.
router.get('/pilot/gtc-diagnostic', requireSuperuser, asyncHandler(async (req, res) => {
  if (req.user.userId !== 1) {
    throw new ValidationError('La cuenta no coincide con la cuenta aislada del piloto');
  }
  const symbol = String(req.query.symbol || '');
  if (!/^ETH-\d{6}-\d+(?:\.\d+)?-C$/.test(symbol)) {
    throw new ValidationError('Contrato ETH CALL invalido');
  }
  const { assess } = require('../scripts/options-gtc-dust-readonly');
  const env = process.env;
  // Desactivar cualquier consulta firmada si un permiso de trading esta ON.
  const flagsOff = env.OPTIONS_LIVE_TRADING_ENABLED === 'false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED !== 'true';
  let report;
  if (!flagsOff) {
    report = await assess({ client: null, symbol, env });
  } else {
    const client = await optionsCredentials.getClientForUser(req.user.userId);
    report = await assess({ client, symbol, env });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: {
    ...report,
    symbol,
    testedQuantity: '0.01',
    hypotheticalPartialFill: '0.005',
    hypotheticalRemainder: '0.005',
    note: 'Consulta filtros, aislamiento y una muestra publica de ejecuciones. Una muestra sin fracciones NO prueba su imposibilidad. El TP propio y cierre del residuo siguen sin verificar.',
  } });
}));

// ------------------------------------------------------------------
// Mercado (datos públicos)
// ------------------------------------------------------------------

router.get('/underlyings', asyncHandler(async (req, res) => {
  const data = await optionsMarket.listUnderlyings();
  res.json({ success: true, data });
}));

router.get('/chain', asyncHandler(async (req, res) => {
  const underlying = String(req.query.underlying || '').trim();
  if (!underlying) throw new ValidationError('underlying es requerido');
  const expiry = req.query.expiry ? String(req.query.expiry).trim() : undefined;
  const data = await optionsMarket.getChain(underlying, expiry);
  res.json({ success: true, data });
}));

// ------------------------------------------------------------------
// Cuenta y posiciones (firmados)
// ------------------------------------------------------------------

router.get('/account', asyncHandler(async (req, res) => {
  const client = await optionsCredentials.getClientForUser(req.user.userId);
  const account = await client.getAccount();
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

  res.json({
    success: true,
    data: {
      balanceUsdt: equity,
      marginUsedUsdt,
      unrealizedPnlUsdt: num(usdt.unrealizedPNL) ?? 0,
      greeks,
    },
  });
}));

router.get('/positions', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const client = await optionsCredentials.getClientForUser(userId);
  const [positions, marks, origins] = await Promise.all([
    client.getPositions(),
    optionsMarket.getMarks().catch(() => []),
    loadPositionOrigins(userId),
  ]);
  const markMap = new Map((Array.isArray(marks) ? marks : []).map((m) => [m.symbol, m]));

  const data = (Array.isArray(positions) ? positions : []).map((p) => {
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
  res.json({ success: true, data });
}));

// ------------------------------------------------------------------
// Órdenes
// ------------------------------------------------------------------

router.get('/orders/open', asyncHandler(async (req, res) => {
  const client = await optionsCredentials.getClientForUser(req.user.userId);
  const orders = await client.getOpenOrders();
  res.json({ success: true, data: (Array.isArray(orders) ? orders : []).map(normalizeOrder) });
}));

router.post('/orders', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const symbol = parseSymbolParam(body.symbol);
  const side = String(body.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new ValidationError('side debe ser BUY o SELL');
  const quantity = parsePositive(body.quantity, 'quantity');
  const price = parsePositive(body.price, 'price');
  const postOnly = parseOptionalBoolean(body.postOnly, 'postOnly');
  const reduceOnly = parseOptionalBoolean(body.reduceOnly, 'reduceOnly');
  let clientOrderId;
  if (body.clientOrderId !== undefined && body.clientOrderId !== null && body.clientOrderId !== '') {
    clientOrderId = String(body.clientOrderId);
    if (!CLIENT_ORDER_ID_REGEX.test(clientOrderId)) throw new ValidationError('clientOrderId inválido');
  }

  const client = await optionsCredentials.getClientForUser(req.user.userId);
  const order = await client.placeOrder({ symbol, side, quantity, price, postOnly, reduceOnly, clientOrderId });
  logger.info('options_manual_order_placed', {
    userId: req.user.userId, symbol, side, quantity, price, orderId: order?.orderId != null ? String(order.orderId) : null,
  });
  res.status(201).json({ success: true, data: normalizeOrder({ symbol, side, price, quantity, postOnly, reduceOnly, ...order }) });
}));

router.delete('/orders/:symbol/:orderId', asyncHandler(async (req, res) => {
  const symbol = parseSymbolParam(req.params.symbol);
  const orderId = String(req.params.orderId || '');
  if (!ORDER_ID_REGEX.test(orderId)) throw new ValidationError('orderId inválido');
  const client = await optionsCredentials.getClientForUser(req.user.userId);
  const result = await client.cancelOrder({ symbol, orderId });
  res.json({ success: true, data: normalizeOrder({ symbol, orderId, ...result }) });
}));

router.get('/trades', asyncHandler(async (req, res) => {
  const days = req.query.days === undefined ? 30 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_TRADE_DAYS) {
    throw new ValidationError(`days debe ser un entero entre 1 y ${MAX_TRADE_DAYS}`);
  }
  const client = await optionsCredentials.getClientForUser(req.user.userId);
  const trades = await client.getUserTrades({ startTime: Date.now() - days * DAY_MS });
  const data = (Array.isArray(trades) ? trades : [])
    .map(normalizeTrade)
    .sort((a, b) => (b.time || 0) - (a.time || 0));
  res.json({ success: true, data });
}));

module.exports = router;

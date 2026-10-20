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
const logger = require('../services/logger.service');
const optionsMarket = require('../services/options/options-market.service');
const optionsCredentials = require('../services/options/options-credentials.service');
const optionsAccount = require('../services/options/options-account.service');
const accountStream = require('../services/options/options-account-stream.service');

const { normalizeOrder } = optionsAccount;

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

/**
 * Ante un 429 de Binance se sirve el último snapshot del stream en tiempo
 * real (si lo hay) en vez de dejar la pantalla vacía con un error.
 */
async function withRateLimitFallback(userId, pick, load) {
  try {
    return await load();
  } catch (err) {
    const last = err?.code === 'BINANCE_OPTIONS_RATE_LIMIT' ? accountStream.getLast(userId) : null;
    if (!last) throw err;
    return pick(last);
  }
}

router.get('/account', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const data = await withRateLimitFallback(userId, (last) => last.account, async () => {
    const client = await optionsCredentials.getClientForUser(userId);
    return optionsAccount.loadAccount(client);
  });
  res.json({ success: true, data });
}));

router.get('/positions', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const data = await withRateLimitFallback(userId, (last) => last.positions, async () => {
    const client = await optionsCredentials.getClientForUser(userId);
    return optionsAccount.loadPositions(client, userId);
  });
  res.json({ success: true, data });
}));

// ------------------------------------------------------------------
// Órdenes
// ------------------------------------------------------------------

router.get('/orders/open', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const data = await withRateLimitFallback(userId, (last) => last.openOrders, async () => {
    const client = await optionsCredentials.getClientForUser(userId);
    return optionsAccount.loadOpenOrders(client);
  });
  res.json({ success: true, data });
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
  accountStream.invalidate(req.user.userId);
  res.status(201).json({ success: true, data: normalizeOrder({ symbol, side, price, quantity, postOnly, reduceOnly, ...order }) });
}));

router.delete('/orders/:symbol/:orderId', asyncHandler(async (req, res) => {
  const symbol = parseSymbolParam(req.params.symbol);
  const orderId = String(req.params.orderId || '');
  if (!ORDER_ID_REGEX.test(orderId)) throw new ValidationError('orderId inválido');
  const client = await optionsCredentials.getClientForUser(req.user.userId);
  const result = await client.cancelOrder({ symbol, orderId });
  accountStream.invalidate(req.user.userId);
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

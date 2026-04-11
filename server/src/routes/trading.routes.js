/**
 * trading.routes.js
 *
 * GET  /api/trading/account              → Estado de cuenta y posiciones
 * GET  /api/trading/orders               → Ordenes abiertas
 * POST /api/trading/open                 → Abrir posicion
 * POST /api/trading/close                → Cerrar posicion
 * DELETE /api/trading/orders/:asset/:oid → Cancelar orden
 */

const { Router } = require('express');
const rateLimit        = require('express-rate-limit');
const asyncHandler     = require('../middleware/async-handler');
const { requireIntParam } = require('../middleware/parse-params');
const { validate } = require('../middleware/validate.middleware');
const { openPositionSchema, closePositionSchema, setSltpSchema } = require('../schemas/trading.schema');
const TradingService   = require('../services/trading.service');
const hlRegistry       = require('../services/hyperliquid.registry');
const tgRegistry       = require('../services/telegram.registry');
const hyperliquidAccountsService = require('../services/hyperliquid-accounts.service');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

// Rate limit para operaciones de trading: 10 por minuto por usuario
const tradingWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `trading:${req.user?.userId}`,
  message: { success: false, error: 'Demasiadas operaciones de trading, espera un momento' },
});

async function getTrading(userId, accountId) {
  const [account, hl, tg] = await Promise.all([
    hyperliquidAccountsService.resolveAccount(userId, accountId),
    hlRegistry.getOrCreate(userId, accountId),
    tgRegistry.getOrCreate(userId),
  ]);
  return new TradingService(userId, account, hl, tg);
}

router.get('/account', asyncHandler(async (req, res) => {
  const trading = await getTrading(req.user.userId, req.query.accountId);
  const data    = await trading.getAccountState({ force: req.query.refresh === '1' });
  res.json({ success: true, data });
}));

router.get('/orders', asyncHandler(async (req, res) => {
  const trading = await getTrading(req.user.userId, req.query.accountId);
  const data    = await trading.getOpenOrders({ force: req.query.refresh === '1' });
  res.json({ success: true, data });
}));

router.post('/open', tradingWriteLimiter, validate(openPositionSchema), asyncHandler(async (req, res) => {
  const { asset, side, size, leverage, marginMode, limitPrice, accountId } = req.body;
  const trading = await getTrading(req.user.userId, accountId);
  const data    = await trading.openPosition({ asset, side, size, leverage, marginMode, limitPrice });
  res.json({ success: true, data });
}));

router.post('/close', tradingWriteLimiter, validate(closePositionSchema), asyncHandler(async (req, res) => {
  const { asset, size, accountId } = req.body;
  const trading = await getTrading(req.user.userId, accountId);
  const data    = await trading.closePosition({ asset, size });
  res.json({ success: true, data });
}));

router.post('/sltp', tradingWriteLimiter, validate(setSltpSchema), asyncHandler(async (req, res) => {
  const { asset, side, size, slPrice, tpPrice, accountId } = req.body;
  const trading = await getTrading(req.user.userId, accountId);
  const results = await trading.setSLTP({ asset, side, size, slPrice, tpPrice });
  res.json({ success: true, data: results });
}));

router.delete('/orders/:asset/:oid', asyncHandler(async (req, res) => {
  const { asset } = req.params;
  const oid = requireIntParam(req, 'oid');
  const trading = await getTrading(req.user.userId, req.query.accountId);
  const data    = await trading.cancelOrder(asset, oid);
  res.json({ success: true, data });
}));

module.exports = router;

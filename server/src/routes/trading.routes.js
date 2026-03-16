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
const asyncHandler     = require('../middleware/async-handler');
const TradingService   = require('../services/trading.service');
const hlRegistry       = require('../services/hyperliquid.registry');
const tgRegistry       = require('../services/telegram.registry');
const hyperliquidAccountsService = require('../services/hyperliquid-accounts.service');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

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

router.post('/open', asyncHandler(async (req, res) => {
  const { asset, side, size, leverage, marginMode, limitPrice, accountId } = req.body;
  if (!asset || !side || !size) {
    return res.status(400).json({ success: false, error: 'Parametros requeridos: asset, side, size' });
  }
  if (!['long', 'short'].includes(side)) {
    return res.status(400).json({ success: false, error: "side debe ser 'long' o 'short'" });
  }
  if (typeof size !== 'number' || size <= 0) {
    return res.status(400).json({ success: false, error: 'size debe ser un numero positivo' });
  }
  const trading = await getTrading(req.user.userId, accountId);
  const data    = await trading.openPosition({ asset, side, size, leverage, marginMode, limitPrice });
  res.json({ success: true, data });
}));

router.post('/close', asyncHandler(async (req, res) => {
  const { asset, size, accountId } = req.body;
  if (!asset) return res.status(400).json({ success: false, error: "Requerido: 'asset'" });
  const trading = await getTrading(req.user.userId, accountId);
  const data    = await trading.closePosition({ asset, size });
  res.json({ success: true, data });
}));

router.post('/sltp', asyncHandler(async (req, res) => {
  const { asset, side, size, slPrice, tpPrice, accountId } = req.body;
  if (!asset || !side || !size) {
    return res.status(400).json({ success: false, error: 'Requeridos: asset, side, size' });
  }
  const trading = await getTrading(req.user.userId, accountId);
  const results = await trading.setSLTP({ asset, side, size, slPrice, tpPrice });
  res.json({ success: true, data: results });
}));

router.delete('/orders/:asset/:oid', asyncHandler(async (req, res) => {
  const { asset } = req.params;
  const oid = parseInt(req.params.oid, 10);
  if (isNaN(oid)) return res.status(400).json({ success: false, error: 'oid debe ser un numero' });
  const trading = await getTrading(req.user.userId, req.query.accountId);
  const data    = await trading.cancelOrder(asset, oid);
  res.json({ success: true, data });
}));

module.exports = router;

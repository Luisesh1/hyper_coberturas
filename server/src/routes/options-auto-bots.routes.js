const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const autoTradingService = require('../services/options/options-auto-trading.service');
const { AppError } = require('../errors/app-error');
const { createAutoBotSchema, updateAutoBotSchema, closeAutoBotSchema, simulateAutoBotSchema, unblockAutoBotSchema } = require('../schemas/options-automation.schema');

// Montado en /options/auto-bots, antes que /options. El detalle, el cambio de
// modo y el borrado de un bot van por /options/strategies/:id.
const router = Router();
router.use(authenticate);

const service = () => autoTradingService;

router.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().listBots(req.user.userId) });
}));

router.get('/eligible-alerts', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().eligibleAlerts(req.user.userId, req.query.underlyings ?? req.query.underlying) });
}));

router.post('/', validate(createAutoBotSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await service().createBot(req.user.userId, req.body) });
}));

router.post('/:id/clone', asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await service().cloneBot(req.user.userId, requireIntParam(req, 'id')) });
}));

router.put('/:id', validate(updateAutoBotSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().updateBot(req.user.userId, requireIntParam(req, 'id'), req.body) });
}));

router.get('/:id/signals', asyncHandler(async (req, res) => {
  const { limit = 100, filter = 'all' } = req.query;
  const data = await service().listSignals(req.user.userId, requireIntParam(req, 'id'), { limit: Number(limit), filter: String(filter) });
  res.json({ success: true, data });
}));

// Cerrar posiciones (en Real envía órdenes LIMIT): exige confirm: true.
function requireConfirm(req, _res, next) {
  if (req.body?.confirm !== true) {
    return next(new AppError('Cerrar posiciones requiere confirmación: envía confirm: true', { status: 400, code: 'CONFIRM_REQUIRED' }));
  }
  return next();
}

router.post('/:id/close', requireConfirm, validate(closeAutoBotSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().closeBot(req.user.userId, requireIntParam(req, 'id'), req.body) });
}));

router.post('/:id/simulate', validate(simulateAutoBotSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().simulateSignal(req.user.userId, requireIntParam(req, 'id'), req.body) });
}));

router.post('/:id/unblock', validate(unblockAutoBotSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().unblockUnderlying(req.user.userId, requireIntParam(req, 'id'), req.body.underlying) });
}));

router.post('/:id/orders/:orderId/cancel', asyncHandler(async (req, res) => {
  const data = await service().cancelOrder(req.user.userId, requireIntParam(req, 'id'), requireIntParam(req, 'orderId'));
  res.json({ success: true, data });
}));

module.exports = router;

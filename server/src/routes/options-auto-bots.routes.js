const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const autoTradingService = require('../services/options/options-auto-trading.service');
const { createAutoBotSchema, updateAutoBotSchema } = require('../schemas/options-automation.schema');

// Montado en /options/auto-bots, antes que /options. El detalle, el cambio de
// modo y el borrado de un bot van por /options/strategies/:id.
const router = Router();
router.use(authenticate);

const service = () => autoTradingService;

router.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().listBots(req.user.userId) });
}));

router.get('/eligible-alerts', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().eligibleAlerts(req.user.userId, req.query.underlying) });
}));

router.post('/', validate(createAutoBotSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await service().createBot(req.user.userId, req.body) });
}));

router.put('/:id', validate(updateAutoBotSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().updateBot(req.user.userId, requireIntParam(req, 'id'), req.body) });
}));

router.get('/:id/signals', asyncHandler(async (req, res) => {
  const { limit = 100, filter = 'all' } = req.query;
  const data = await service().listSignals(req.user.userId, requireIntParam(req, 'id'), { limit: Number(limit), filter: String(filter) });
  res.json({ success: true, data });
}));

module.exports = router;

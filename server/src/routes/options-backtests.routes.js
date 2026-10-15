const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const backtestService = require('../services/options/options-backtest.service');
const { createBacktestSchema } = require('../schemas/options-automation.schema');

// Montado en /options/backtests, antes que /options (Backend A).
const router = Router();
router.use(authenticate);

const service = () => backtestService;

// Crea la tarea y responde enseguida: el backtest corre en segundo plano.
router.post('/', validate(createBacktestSchema), asyncHandler(async (req, res) => {
  res.status(202).json({ success: true, data: await service().enqueue(req.user.userId, req.body) });
}));

router.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().list(req.user.userId) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().get(req.user.userId, requireIntParam(req, 'id')) });
}));

module.exports = router;

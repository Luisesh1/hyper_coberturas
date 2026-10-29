const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const strategiesService = require('../services/options/options-strategies.service');
const {
  createStrategySchema,
  updateStrategySchema,
  strategyModeSchema,
} = require('../schemas/options-automation.schema');

// Montado en /options/strategies, antes que /options (Backend A).
const router = Router();
router.use(authenticate);

const service = () => strategiesService;

router.get('/templates', (req, res) => {
  res.json({ success: true, data: service().listTemplates() });
});

router.get('/', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().list(req.user.userId) });
}));

router.post('/', validate(createStrategySchema), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await service().create(req.user.userId, req.body) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().get(req.user.userId, requireIntParam(req, 'id'), { since: req.query.since }) });
}));

router.put('/:id', validate(updateStrategySchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().update(req.user.userId, requireIntParam(req, 'id'), req.body) });
}));

router.put('/:id/mode', validate(strategyModeSchema), asyncHandler(async (req, res) => {
  const data = await service().setMode(req.user.userId, requireIntParam(req, 'id'), req.body);
  res.json({ success: true, data });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().remove(req.user.userId, requireIntParam(req, 'id')) });
}));

module.exports = router;

const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const strategiesService = require('../services/strategies.service');

const router = Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const data = await strategiesService.listStrategies(req.user.userId);
  res.json({ success: true, data });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const data = await strategiesService.getStrategy(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = await strategiesService.createStrategy(req.user.userId, req.body);
  res.status(201).json({ success: true, data });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const data = await strategiesService.updateStrategy(req.user.userId, Number(req.params.id), req.body);
  res.json({ success: true, data });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const data = await strategiesService.deleteStrategy(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.post('/:id/validate', asyncHandler(async (req, res) => {
  const data = await strategiesService.validateStrategy(req.user.userId, Number(req.params.id), req.body);
  res.json({ success: true, data });
}));

router.post('/:id/backtest', asyncHandler(async (req, res) => {
  const data = await strategiesService.backtestStrategy(req.user.userId, Number(req.params.id), req.body);
  res.json({ success: true, data });
}));

module.exports = router;

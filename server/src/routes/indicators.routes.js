const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const indicatorsService = require('../services/indicators.service');

const router = Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const data = await indicatorsService.listIndicators(req.user.userId);
  res.json({ success: true, data });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = await indicatorsService.createIndicator(req.user.userId, req.body);
  res.status(201).json({ success: true, data });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const data = await indicatorsService.updateIndicator(req.user.userId, Number(req.params.id), req.body);
  res.json({ success: true, data });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const data = await indicatorsService.deleteIndicator(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

module.exports = router;

const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const backtestingService = require('../services/backtesting.service');

const router = Router();
router.use(authenticate);

router.post('/simulate', asyncHandler(async (req, res) => {
  const data = await backtestingService.simulateBacktest(req.user.userId, req.body);
  res.json({ success: true, data });
}));

module.exports = router;

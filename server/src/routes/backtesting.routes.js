const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const backtestingService = require('../services/backtesting.service');
const backtestQueue = require('../services/backtest-queue.service');

const router = Router();
router.use(authenticate);

router.post('/simulate', asyncHandler(async (req, res) => {
  const data = await backtestingService.simulateBacktest(req.user.userId, req.body);
  res.json({ success: true, data });
}));

router.post('/queue', asyncHandler(async (req, res) => {
  const { jobId, position } = backtestQueue.enqueue(req.user.userId, req.body);
  res.json({ success: true, data: { jobId, position } });
}));

router.get('/jobs', asyncHandler(async (req, res) => {
  const jobs = backtestQueue.getUserJobs(req.user.userId);
  res.json({ success: true, data: jobs });
}));

router.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const job = backtestQueue.getJob(req.params.jobId, req.user.userId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job no encontrado' });
  }
  res.json({ success: true, data: job });
}));

module.exports = router;

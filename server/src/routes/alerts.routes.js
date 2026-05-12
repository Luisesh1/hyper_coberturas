const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const alertsService = require('../services/alerts/alerts.service');

const router = Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const data = await alertsService.listAlerts(req.user.userId);
  res.json({ success: true, data });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = await alertsService.createAlert(req.user.userId, req.body);
  res.status(201).json({ success: true, data });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const data = await alertsService.getAlert(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const data = await alertsService.updateAlert(req.user.userId, Number(req.params.id), req.body);
  res.json({ success: true, data });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const data = await alertsService.deleteAlert(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.post('/:id/test', asyncHandler(async (req, res) => {
  const dryRun = req.body?.dryRun !== false; // default true (no envía Telegram)
  const data = await alertsService.testAlertNow(req.user.userId, Number(req.params.id), { dryRun });
  res.json({ success: true, data });
}));

router.get('/:id/events', asyncHandler(async (req, res) => {
  const limit = req.query?.limit ? Number(req.query.limit) : 50;
  const data = await alertsService.listAlertEvents(req.user.userId, Number(req.params.id), { limit });
  res.json({ success: true, data });
}));

module.exports = router;

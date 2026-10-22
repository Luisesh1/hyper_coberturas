const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { z } = require('zod');
const alertsService = require('../services/alerts/alerts.service');
const alertBacktest = require('../services/alerts/alert-backtest.service');
const { AppError, ValidationError, ExternalServiceError } = require('../errors/app-error');
const logger = require('../services/logger.service');

const backtestBodySchema = z.object({
  asset: z.string().trim().min(1),
  datasource: z.enum(alertsService.DATASOURCES),
  startTime: z.number().int().positive(),
  endTime: z.number().int().positive(),
}).refine((b) => b.startTime < b.endTime, { message: 'startTime debe ser menor que endTime', path: ['startTime'] });

function parseBacktestBody(body) {
  const parsed = backtestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(`Body inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ')}`);
  }
  return parsed.data;
}

// Fallos ajenos a la validación (proveedor de velas caído…) salen como 502,
// pero antes se registra el error original para poder diagnosticarlo.
async function runBacktest(userId, alertId, body) {
  try {
    return await alertBacktest.run(userId, alertId, body);
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn('alerts_backtest_failed', {
      alertId, asset: body?.asset, datasource: body?.datasource, error: err?.message, stack: err?.stack,
    });
    throw new ExternalServiceError(`No se pudieron obtener las velas: ${err?.message}`);
  }
}

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

router.post('/:id/backtest', asyncHandler(async (req, res) => {
  const body = parseBacktestBody(req.body);
  const data = await runBacktest(req.user.userId, Number(req.params.id), body);
  res.json({ success: true, data });
}));

module.exports = router;
module.exports.parseBacktestBody = parseBacktestBody;
module.exports.runBacktest = runBacktest;

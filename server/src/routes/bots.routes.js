const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const botsService = require('../services/bots.service');
const botRegistry = require('../services/bot.registry');

const router = Router();
router.use(authenticate);

// Rate limit para operaciones de lifecycle de bots: 10 por minuto por usuario
const botLifecycleLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `bot:${req.user?.userId}`,
  message: { success: false, error: 'Demasiadas operaciones de bot, espera un momento' },
});

router.get('/', asyncHandler(async (req, res) => {
  const data = await botsService.listBots(req.user.userId);
  res.json({ success: true, data });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const data = await botsService.getBot(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = await botsService.createBot(req.user.userId, req.body);
  res.status(201).json({ success: true, data });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const data = await botsService.updateBot(req.user.userId, Number(req.params.id), req.body);
  res.json({ success: true, data });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const data = await botsService.deleteBot(req.user.userId, Number(req.params.id));
  botRegistry.destroy(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.post('/:id/duplicate', asyncHandler(async (req, res) => {
  const data = await botsService.duplicateBot(req.user.userId, Number(req.params.id));
  res.status(201).json({ success: true, data });
}));

router.post('/:id/activate', botLifecycleLimiter, asyncHandler(async (req, res) => {
  await botRegistry.activate(req.user.userId, Number(req.params.id));
  const data = await botsService.getBot(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.post('/:id/pause', botLifecycleLimiter, asyncHandler(async (req, res) => {
  await botRegistry.pause(req.user.userId, Number(req.params.id));
  const data = await botsService.getBot(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.post('/:id/stop', botLifecycleLimiter, asyncHandler(async (req, res) => {
  await botRegistry.stop(req.user.userId, Number(req.params.id));
  const data = await botsService.getBot(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

router.get('/:id/runs', asyncHandler(async (req, res) => {
  const data = await botsService.listBotRuns(req.user.userId, Number(req.params.id));
  res.json({ success: true, data });
}));

module.exports = router;

/**
 * hedge.routes.js
 *
 * GET    /api/hedge       → Lista coberturas del usuario autenticado
 * GET    /api/hedge/:id   → Detalle de una cobertura
 * POST   /api/hedge       → Crear cobertura
 * DELETE /api/hedge/:id   → Cancelar cobertura
 */

const { Router } = require('express');
const rateLimit        = require('express-rate-limit');
const hedgeRegistry    = require('../services/hedge.registry');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const asyncHandler = require('../middleware/async-handler');
const { requireIntParam, optionalIntQuery } = require('../middleware/parse-params');
const { createHedgeSchema } = require('../schemas/hedge.schema');

const router = Router();
router.use(authenticate);

// Rate limit para operaciones de hedge: 5 por minuto por usuario
const hedgeWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `hedge:${req.user?.userId}`,
  message: { success: false, error: 'Demasiadas operaciones de cobertura, espera un momento' },
});

router.get('/', asyncHandler(async (req, res) => {
  const accountId = optionalIntQuery(req, 'accountId');
  const services = accountId != null
    ? [await hedgeRegistry.getOrCreate(req.user.userId, accountId)]
    : await hedgeRegistry.getOrCreateAllForUser(req.user.userId);
  const hedges = services
    .flatMap((svc) => svc.getAll())
    .sort((a, b) => b.id - a.id);
  res.json({ success: true, data: hedges });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = requireIntParam(req, 'id');
  const services = await hedgeRegistry.getOrCreateAllForUser(req.user.userId);
  const hedge = services
    .map((svc) => svc.hedges.get(id))
    .find(Boolean);
  if (!hedge) throw new Error(`Cobertura #${req.params.id} no encontrada`);
  res.json({ success: true, data: hedge });
}));

router.post('/', hedgeWriteLimiter, validate(createHedgeSchema), asyncHandler(async (req, res) => {
  const { asset, entryPrice, exitPrice, size, leverage, label, direction, accountId } = req.body;
  const svc   = await hedgeRegistry.getOrCreate(req.user.userId, accountId);
  const hedge = await svc.createHedge({ asset, entryPrice, exitPrice, size, leverage, label, direction });
  res.status(201).json({ success: true, data: hedge });
}));

router.delete('/:id', hedgeWriteLimiter, asyncHandler(async (req, res) => {
  const id = requireIntParam(req, 'id');
  const services = await hedgeRegistry.getOrCreateAllForUser(req.user.userId);
  const svc = services.find((item) => item.hedges.has(id));
  if (!svc) return res.status(404).json({ success: false, error: 'Cobertura no encontrada' });
  const hedge = await svc.cancelHedge(id);
  res.json({ success: true, data: hedge });
}));

module.exports = router;

const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const lpOrchestratorService = require('../services/lp-orchestrator.service');
const lpOrchestratorRepository = require('../repositories/lp-orchestrator.repository');
const {
  createOrchestratorSchema,
  attachLpSchema,
  recordTxFinalizedSchema,
  killLpSchema,
} = require('../schemas/lp-orchestrator.schema');

const router = Router();
router.use(authenticate);

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ success: false, error: 'ID invalido' });
    return null;
  }
  return id;
}

router.get('/', asyncHandler(async (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  const data = await lpOrchestratorRepository.listForUser(req.user.userId, { includeArchived });
  res.json({ success: true, data });
}));

router.post('/', validate(createOrchestratorSchema), asyncHandler(async (req, res) => {
  const data = await lpOrchestratorService.createOrchestrator({
    userId: req.user.userId,
    ...req.body,
  });
  res.status(201).json({ success: true, data });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const data = await lpOrchestratorRepository.getById(req.user.userId, id);
  if (!data) {
    return res.status(404).json({ success: false, error: 'Orquestador no encontrado' });
  }
  res.json({ success: true, data });
}));

router.get('/:id/action-log', asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const data = await lpOrchestratorRepository.listActionLog(
    req.user.userId,
    id,
    { limit }
  );
  res.json({ success: true, data });
}));

router.post('/:id/evaluate', asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const result = await lpOrchestratorService.evaluateOne(req.user.userId, id);
  const data = await lpOrchestratorRepository.getById(req.user.userId, id);
  res.json({ success: true, data: { result, orchestrator: data } });
}));

/**
 * Reconcilia el `activePositionIdentifier` con la wallet on-chain. Útil
 * cuando el cliente sospecha que el orquestador quedó stale (ej. timeout
 * tras un modify-range cuyo finalize no llegó al servidor). Devuelve el
 * orquestador actualizado para que la UI no tenga que esperar al loop
 * de evaluación de fondo.
 */
router.post('/:id/reconcile', asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const result = await lpOrchestratorService.reconcileOne(req.user.userId, id);
  const data = await lpOrchestratorRepository.getById(req.user.userId, id);
  res.json({ success: true, data: { result, orchestrator: data } });
}));

router.post('/:id/attach-lp', validate(attachLpSchema), asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const data = await lpOrchestratorService.attachLp({
    userId: req.user.userId,
    orchestratorId: id,
    ...req.body,
  });
  res.json({ success: true, data });
}));

// Lista los LPs huérfanos en la wallet que coinciden con el par/red/fee
// del orquestador. Útil cuando un attach-lp falló (ej. server reinició a
// medio camino) y el LP quedó creado on-chain pero sin vincular.
router.get('/:id/adoptable-lps', asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const data = await lpOrchestratorService.discoverAdoptableLps(req.user.userId, id);
  res.json({ success: true, data });
}));

// Adopta una posición LP existente de la wallet vinculándola al
// orquestador. Equivalente a attach-lp pero sin necesidad de un finalize
// recién firmado: usa el positionIdentifier que el usuario eligió desde
// la lista de adoptable-lps.
router.post('/:id/adopt-lp', asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const { positionIdentifier, protectionConfig } = req.body || {};
  const data = await lpOrchestratorService.adoptLp(req.user.userId, id, {
    positionIdentifier,
    protectionConfig,
  });
  res.json({ success: true, data });
}));

router.post('/:id/record-tx-finalized', validate(recordTxFinalizedSchema), asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const data = await lpOrchestratorService.recordTxFinalized({
    userId: req.user.userId,
    orchestratorId: id,
    ...req.body,
  });
  res.json({ success: true, data });
}));

router.post('/:id/kill-lp', validate(killLpSchema), asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const data = await lpOrchestratorService.killLp({
    userId: req.user.userId,
    orchestratorId: id,
    mode: req.body.mode,
  });
  res.json({ success: true, data });
}));

router.post('/:id/archive', asyncHandler(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const data = await lpOrchestratorService.archive({
    userId: req.user.userId,
    orchestratorId: id,
  });
  res.json({ success: true, data });
}));

module.exports = router;

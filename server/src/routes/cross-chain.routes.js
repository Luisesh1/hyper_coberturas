const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate, validateQuery } = require('../middleware/validate.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const config = require('../config');
const { AppError } = require('../errors/app-error');
const crossChain = require('../services/cross-chain');
const {
  fundingAnalysisSchema,
  prepareStepSchema,
  submitStepSchema,
  walletQuerySchema,
} = require('../schemas/cross-chain.schema');

const router = Router();
router.use(authenticate);

const mode = () => config.crossChainFunding.mode;

router.get('/config', (req, res) => {
  res.json({ success: true, data: { mode: mode() } });
});

// Con el flag apagado el resto de rutas no existe.
router.use((req, res, next) => {
  if (mode() === 'off') {
    return next(new AppError('No encontrado', { status: 404, code: 'NOT_FOUND' }));
  }
  return next();
});

function requireExecute(req, res, next) {
  if (mode() !== 'execute') {
    return next(new AppError('La ejecución cross-chain está desactivada en este entorno.', { status: 403, code: 'FEATURE_DISABLED' }));
  }
  return next();
}

const service = () => crossChain.service;

router.get('/balances', validateQuery(walletQuerySchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().getBalances({ walletAddress: req.query.walletAddress }) });
}));

router.post('/funding-analysis', validate(fundingAnalysisSchema), asyncHandler(async (req, res) => {
  const analysis = await service().analyze(req.body);
  res.json({ success: true, data: service().toPublicAnalysis(analysis) });
}));

router.get('/plans/active', validateQuery(walletQuerySchema), asyncHandler(async (req, res) => {
  const data = await service().getActivePlan({ userId: req.user.userId, walletAddress: req.query.walletAddress });
  res.json({ success: true, data });
}));

router.get('/plans/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().getPlanView({ userId: req.user.userId, planId: requireIntParam(req, 'id') }) });
}));

router.post('/plans', requireExecute, validate(fundingAnalysisSchema), asyncHandler(async (req, res) => {
  const plan = await service().createPlan({ userId: req.user.userId, input: req.body });
  res.status(201).json({ success: true, data: service().planView(plan) });
}));

router.post(
  '/plans/:id/steps/:order/prepare',
  requireExecute,
  validate(prepareStepSchema),
  asyncHandler(async (req, res) => {
    const data = await service().prepareStep({
      userId: req.user.userId,
      planId: requireIntParam(req, 'id'),
      order: requireIntParam(req, 'order'),
      speedUp: req.body.speedUp === true,
    });
    res.json({ success: true, data });
  })
);

// Registrar una tx ya firmada no depende del modo: si se apaga el flag con
// envíos en vuelo, sus hashes tienen que poder guardarse igual.
router.post(
  '/plans/:id/steps/:order/submitted',
  validate(submitStepSchema),
  asyncHandler(async (req, res) => {
    const data = await service().submitStep({
      userId: req.user.userId,
      planId: requireIntParam(req, 'id'),
      order: requireIntParam(req, 'order'),
      kind: req.body.kind,
      txHash: req.body.txHash,
      nonce: req.body.nonce ?? null,
      fees: req.body.fees ?? null,
    });
    res.json({ success: true, data });
  })
);

router.post('/plans/:id/steps/:order/skip', asyncHandler(async (req, res) => {
  const data = await service().skipStep({ userId: req.user.userId, planId: requireIntParam(req, 'id'), order: requireIntParam(req, 'order') });
  res.json({ success: true, data });
}));

router.post('/plans/:id/continue', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().continueWithArrived({ userId: req.user.userId, planId: requireIntParam(req, 'id') }) });
}));

router.post('/plans/:id/discard', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service().discardPlan({ userId: req.user.userId, planId: requireIntParam(req, 'id') }) });
}));

module.exports = router;

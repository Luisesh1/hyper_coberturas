const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const uniswapService = require('../services/uniswap.service');
const uniswapProtectionService = require('../services/uniswap-protection.service');
const protectedPoolRefreshService = require('../services/protected-pool-refresh.service');
const {
  createProtectedPoolSchema,
  scanPoolsSchema,
  claimFeesPrepareSchema,
  claimFeesFinalizeSchema,
  increaseLiquidityPrepareSchema,
  decreaseLiquidityPrepareSchema,
  collectFeesPrepareSchema,
  reinvestFeesPrepareSchema,
  modifyRangePrepareSchema,
  rebalancePrepareSchema,
  createPositionPrepareSchema,
  positionActionFinalizeSchema,
} = require('../schemas/uniswap.schema');
const claimFeesService = require('../services/uniswap-claim-fees.service');
const positionActionsService = require('../services/uniswap-position-actions.service');

const router = Router();
router.use(authenticate);

const ACTION_SCHEMAS = {
  'increase-liquidity': increaseLiquidityPrepareSchema,
  'decrease-liquidity': decreaseLiquidityPrepareSchema,
  'collect-fees': collectFeesPrepareSchema,
  'reinvest-fees': reinvestFeesPrepareSchema,
  'modify-range': modifyRangePrepareSchema,
  'rebalance': rebalancePrepareSchema,
  'create-position': createPositionPrepareSchema,
};

router.get('/meta', (req, res) => {
  res.json({ success: true, data: uniswapService.getSupportMatrix() });
});

router.post('/pools/scan', validate(scanPoolsSchema), asyncHandler(async (req, res) => {
  const data = await uniswapService.scanPoolsCreatedByWallet({
    ...req.body,
    userId: req.user.userId,
  });
  res.json({ success: true, data });
}));

router.get('/protected-pools', asyncHandler(async (req, res) => {
  const data = await uniswapProtectionService.listProtectedPools(req.user.userId);
  res.json({ success: true, data });
}));

router.post('/protected-pools/refresh', asyncHandler(async (req, res) => {
  await protectedPoolRefreshService.refreshUser(req.user.userId);
  const data = await uniswapProtectionService.listProtectedPools(req.user.userId);
  res.json({ success: true, data });
}));

router.post('/protected-pools', validate(createProtectedPoolSchema), asyncHandler(async (req, res) => {
  const data = await uniswapProtectionService.createProtectedPool({
    userId: req.user.userId,
    ...req.body,
  });
  res.status(201).json({ success: true, data });
}));

router.post('/protected-pools/:id/deactivate', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'ID invalido' });
  }

  const data = await uniswapProtectionService.deactivateProtectedPool(req.user.userId, id);
  res.json({ success: true, data });
}));

// --- Claim Fees -------------------------------------------------------

router.post('/claim-fees/prepare', validate(claimFeesPrepareSchema), asyncHandler(async (req, res) => {
  const data = await claimFeesService.prepareClaimFees(req.body);
  res.json({ success: true, data });
}));

router.post('/claim-fees/finalize', validate(claimFeesFinalizeSchema), asyncHandler(async (req, res) => {
  const data = await claimFeesService.finalizeClaimFees(req.body);
  res.json({ success: true, data });
}));

Object.entries(ACTION_SCHEMAS).forEach(([action, schema]) => {
  router.post(`/${action}/prepare`, validate(schema), asyncHandler(async (req, res) => {
    const data = await positionActionsService.preparePositionAction({
      action,
      payload: req.body,
    });
    res.json({ success: true, data });
  }));

  router.post(`/${action}/finalize`, validate(positionActionFinalizeSchema), asyncHandler(async (req, res) => {
    const data = await positionActionsService.finalizePositionAction({
      userId: req.user.userId,
      action,
      ...req.body,
    });
    res.json({ success: true, data });
  }));
});

module.exports = router;

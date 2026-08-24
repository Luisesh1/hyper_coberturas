const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const uniswapService = require('../services/uniswap.service');
const uniswapProtectionService = require('../services/uniswap-protection.service');
const protectedPoolRefreshService = require('../services/protected-pool-refresh.service');
const protectedPoolDeltaNeutralService = require('../services/protected-pool-delta-neutral.service');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const smartPoolCreatorService = require('../services/smart-pool-creator.service');
const uniswapOperationService = require('../services/uniswap-operation.service');
const {
  createProtectedPoolSchema,
  scanPoolsSchema,
  claimFeesPrepareSchema,
  claimFeesFinalizeSchema,
  increaseLiquidityPrepareSchema,
  increaseLiquidityFundingPlanSchema,
  decreaseLiquidityPrepareSchema,
  collectFeesPrepareSchema,
  reinvestFeesPrepareSchema,
  modifyRangePrepareSchema,
  rebalancePrepareSchema,
  createPositionPrepareSchema,
  closeToUsdcPrepareSchema,
  closeKeepAssetsPrepareSchema,
  positionActionFinalizeSchema,
  smartCreateSuggestSchema,
  smartCreateFundingPlanSchema,
} = require('../schemas/uniswap.schema');
const claimFeesService = require('../services/uniswap-claim-fees.service');
const positionActionsService = require('../services/uniswap-position-actions.service');
const smartContractRegistryRepository = require('../repositories/smart-contract-registry.repository');
const { ValidationError } = require('../errors/app-error');

const router = Router();
router.use(authenticate);

const V4_DYNAMIC_FEE_FLAG = 0x800000;

/**
 * La dirección de un hook cambia la identidad de una PoolKey. Para una
 * tarifa dinámica no aceptamos direcciones arbitrarias: la versión debe haber
 * pasado la verificación de bytecode y permisos para el mismo usuario y red.
 */
async function assertVerifiedDynamicFeeHook(userId, payload) {
  const versionId = payload?.v4DynamicFeeHookVersionId;
  const isDynamicFee = Number(payload?.fee) === V4_DYNAMIC_FEE_FLAG;
  if (versionId == null && !isDynamicFee) return;
  if (payload?.version !== 'v4' || !payload?.hooks || versionId == null) {
    throw new ValidationError('Una tarifa dinámica V4 requiere un hook verificado.');
  }
  const verified = await smartContractRegistryRepository.listVerifiedHooks(userId, payload.network);
  const selected = verified.find((item) => (
    Number(item.id) === Number(versionId)
    && String(item.deployment?.address || '').toLowerCase() === String(payload.hooks).toLowerCase()
  ));
  if (!selected) {
    throw new ValidationError('El hook dinámico seleccionado no está verificado para esta red.');
  }
}

const ACTION_SCHEMAS = {
  'increase-liquidity': increaseLiquidityPrepareSchema,
  'decrease-liquidity': decreaseLiquidityPrepareSchema,
  'collect-fees': collectFeesPrepareSchema,
  'reinvest-fees': reinvestFeesPrepareSchema,
  'modify-range': modifyRangePrepareSchema,
  'rebalance': rebalancePrepareSchema,
  'create-position': createPositionPrepareSchema,
  'close-to-usdc': closeToUsdcPrepareSchema,
  'close-keep-assets': closeKeepAssetsPrepareSchema,
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

async function handleProtectedPoolDiagnostics(req, res) {
  const id = requireIntParam(req, 'id');
  const diagnostics = await uniswapProtectionService.diagnoseDeltaNeutral(req.user.userId, id);
  res.json({ success: true, data: diagnostics });
}

router.get('/protected-pools/:id/diagnose', asyncHandler(handleProtectedPoolDiagnostics));
router.get('/protected-pools/:id/diagnostics', asyncHandler(handleProtectedPoolDiagnostics));


router.post('/protected-pools/refresh', asyncHandler(async (req, res) => {
  await protectedPoolRefreshService.refreshUser(req.user.userId);
  const data = await uniswapProtectionService.listProtectedPools(req.user.userId);
  res.json({ success: true, data });
}));

router.post('/protected-pools/:id/refresh-snapshot', asyncHandler(async (req, res) => {
  const id = requireIntParam(req, 'id');
  const data = await protectedPoolRefreshService.refreshProtection(req.user.userId, id);
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
  const id = requireIntParam(req, 'id');
  const data = await uniswapProtectionService.deactivateProtectedPool(req.user.userId, id);
  res.json({ success: true, data });
}));

/**
 * Force-close del hedge corto cuando una protección quedó huérfana:
 * marcada como `inactive` en BD pero con la posición short todavía abierta
 * en Hyperliquid. Esto pasaba en el flujo legacy de close-LP que solo
 * marcaba la protección como inactiva sin cerrar el short. El endpoint
 * funciona sobre cualquier protección (activa o inactiva) del usuario.
 */
router.post('/protected-pools/:id/force-close-hedge', asyncHandler(async (req, res) => {
  const id = requireIntParam(req, 'id');
  const protection = await protectedPoolRepository.getById(req.user.userId, id);
  if (!protection) {
    return res.status(404).json({ success: false, error: 'Protección no encontrada' });
  }
  if (protection.protectionMode !== 'delta_neutral') {
    return res.status(400).json({ success: false, error: 'force-close-hedge solo aplica a protecciones delta_neutral' });
  }
  const result = await protectedPoolDeltaNeutralService.forceCloseHedge(protection);
  res.json({ success: true, data: result });
}));

// --- Smart Pool Creation -------------------------------------------------------

router.post('/smart-create/suggest', validate(smartCreateSuggestSchema), asyncHandler(async (req, res) => {
  await assertVerifiedDynamicFeeHook(req.user.userId, req.body);
  const data = await smartPoolCreatorService.getSuggestions(req.body);
  res.json({ success: true, data });
}));

router.get('/smart-create/token-list', asyncHandler(async (req, res) => {
  const network = req.query.network || 'ethereum';
  // `version` cambia el catalogo: v4 ofrece el nativo en vez del envuelto.
  const version = req.query.version || 'v3';
  const list = smartPoolCreatorService.getKnownTokens(network, { version });
  res.json({ success: true, data: list });
}));

/**
 * GET /smart-create/pools?network=&version=
 * Pools que EXISTEN on-chain para esa red + version. La UI lo usa para
 * ofrecer solo pares seleccionables en vez de dejar componer uno inexistente
 * y fallar recien al crear la posicion.
 */
router.get('/smart-create/pools', asyncHandler(async (req, res) => {
  const network = String(req.query.network || 'arbitrum');
  const version = String(req.query.version || 'v3');
  const data = await smartPoolCreatorService.discoverAvailablePools({ network, version });
  res.json({ success: true, data });
}));

router.get('/smart-create/assets', asyncHandler(async (req, res) => {
  const network = String(req.query.network || 'ethereum');
  const walletAddress = String(req.query.walletAddress || '').trim();
  if (!walletAddress) {
    return res.status(400).json({ success: false, error: 'walletAddress es requerido' });
  }
  const importTokenAddresses = String(req.query.importTokenAddresses || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const data = await smartPoolCreatorService.getWalletAssets({
    network,
    walletAddress,
    importTokenAddresses,
  });
  res.json({ success: true, data });
}));

router.post('/smart-create/funding-plan', validate(smartCreateFundingPlanSchema), asyncHandler(async (req, res) => {
  await assertVerifiedDynamicFeeHook(req.user.userId, req.body);
  const data = await smartPoolCreatorService.buildFundingPlan(req.body);
  res.json({ success: true, data });
}));

// Smart funding-plan preview para increase-liquidity sobre una posición
// existente. Reusa toda la maquinaria de smart-create pero deriva el rango
// y los tokens desde la posición en vez de pedirlos al cliente.
router.post(
  '/increase-liquidity/funding-plan',
  validate(increaseLiquidityFundingPlanSchema),
  asyncHandler(async (req, res) => {
    const data = await positionActionsService.buildIncreaseLiquidityFundingPlanFromPosition(req.body);
    res.json({ success: true, data });
  }),
);

// --- Claim Fees -------------------------------------------------------

router.post('/claim-fees/prepare', validate(claimFeesPrepareSchema), asyncHandler(async (req, res) => {
  const data = await claimFeesService.prepareClaimFees(req.body);
  res.json({ success: true, data });
}));

router.post('/claim-fees/finalize', validate(claimFeesFinalizeSchema), asyncHandler(async (req, res) => {
  const data = await uniswapOperationService.submitClaimFeesFinalize({
    userId: req.user.userId,
    ...req.body,
  });
  res.json({ success: true, data });
}));

router.get('/operations/:id', asyncHandler(async (req, res) => {
  const id = requireIntParam(req, 'id');
  const data = await uniswapOperationService.getOperation(req.user.userId, id);
  res.json({ success: true, data });
}));

Object.entries(ACTION_SCHEMAS).forEach(([action, schema]) => {
  router.post(`/${action}/prepare`, validate(schema), asyncHandler(async (req, res) => {
    if (action === 'create-position') {
      await assertVerifiedDynamicFeeHook(req.user.userId, req.body);
    }
    const data = await positionActionsService.preparePositionAction({
      action,
      payload: req.body,
    });
    res.json({ success: true, data });
  }));

  router.post(`/${action}/finalize`, validate(positionActionFinalizeSchema), asyncHandler(async (req, res) => {
    const data = await uniswapOperationService.submitPositionActionFinalize({
      userId: req.user.userId,
      action,
      ...req.body,
    });
    res.json({ success: true, data });
  }));
});

module.exports = router;

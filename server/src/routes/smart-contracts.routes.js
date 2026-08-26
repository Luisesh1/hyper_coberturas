const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireIntParam } = require('../middleware/parse-params');
const repository = require('../repositories/smart-contract-registry.repository');
const { SmartContractRegistryService, hookSafetyFor } = require('../services/smart-contract-registry.workflow.service');
const { selectVerifiedHookVersions } = require('../services/smart-contract-registry.service');
const { HookDeploymentService } = require('../services/hook-deployment.workflow.service');
const {
  createContractSchema, createVersionSchema, recordDeploymentSchema, verifyVersionSchema,
  catalogNetworkSchema, adoptSchema,
} = require('../schemas/smart-contract-registry.schema');

const router = Router();
router.use(authenticate);

router.get('/verified-hooks', asyncHandler(async (req, res) => {
  const network = String(req.query.network || '').trim();
  if (!network) return res.status(400).json({ success: false, error: 'network es requerido' });
  const data = selectVerifiedHookVersions(
    await repository.listVerifiedHooks(req.user.userId, network),
    { network }
  );
  res.json({ success: true, data });
}));

// El catalogo de contratos desplegables del proyecto. Va antes de la ruta
// generica `/` para que Express no se coma `/catalog`.
router.get('/catalog', asyncHandler(async (req, res) => {
  const parsed = catalogNetworkSchema.safeParse({ network: String(req.query.network || '').trim() });
  if (!parsed.success) return res.status(400).json({ success: false, error: 'network no soportada' });
  const data = await new HookDeploymentService().describeCatalog({ network: parsed.data.network });
  res.json({ success: true, data });
}));

router.post('/catalog/:name/plan', validate(catalogNetworkSchema), asyncHandler(async (req, res) => {
  const data = await new HookDeploymentService().buildDeploymentPlan({
    name: req.params.name,
    network: req.body.network,
  });
  res.json({ success: true, data });
}));

router.post('/catalog/:name/adopt', validate(adoptSchema), asyncHandler(async (req, res) => {
  const data = await new HookDeploymentService().adopt({
    userId: req.user.userId,
    name: req.params.name,
    network: req.body.network,
    txHash: req.body.txHash || null,
  });
  res.json({ success: true, data });
}));

router.get('/', asyncHandler(async (req, res) => {
  const data = await repository.listContracts(req.user.userId);
  res.json({ success: true, data });
}));

router.post('/', validate(createContractSchema), asyncHandler(async (req, res) => {
  const id = await repository.createContract({ userId: req.user.userId, ...req.body });
  res.status(201).json({ success: true, data: { id } });
}));

router.post('/:id/versions', validate(createVersionSchema), asyncHandler(async (req, res) => {
  const contractId = requireIntParam(req, 'id');
  const id = await repository.createVersion({ userId: req.user.userId, contractId, ...req.body, abiJson: req.body.abi || [] });
  if (!id) return res.status(404).json({ success: false, error: 'Contrato no encontrado' });
  res.status(201).json({ success: true, data: { id, status: 'verification' } });
}));

router.post('/versions/:id/deployments', validate(recordDeploymentSchema), asyncHandler(async (req, res) => {
  const contractVersionId = requireIntParam(req, 'id');
  const id = await repository.recordDeployment({
    userId: req.user.userId,
    contractVersionId,
    ...req.body,
    onchainBytecodeHash: null,
    hookSafety: hookSafetyFor(req.body.address),
  });
  if (!id) return res.status(404).json({ success: false, error: 'Versión no encontrada' });
  res.status(201).json({ success: true, data: { id } });
}));

router.post('/versions/:id/verify', validate(verifyVersionSchema), asyncHandler(async (req, res) => {
  const versionId = requireIntParam(req, 'id');
  const service = new SmartContractRegistryService();
  const data = await service.verifyVersion({ userId: req.user.userId, versionId, network: req.body.network });
  res.json({ success: true, data });
}));

module.exports = router;

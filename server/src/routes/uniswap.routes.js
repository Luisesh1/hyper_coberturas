const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const uniswapService = require('../services/uniswap.service');
const uniswapProtectionService = require('../services/uniswap-protection.service');
const { createProtectedPoolSchema, scanPoolsSchema } = require('../schemas/uniswap.schema');

const router = Router();
router.use(authenticate);

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

module.exports = router;

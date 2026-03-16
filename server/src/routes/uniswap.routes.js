const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const { authenticate } = require('../middleware/auth.middleware');
const {
  scanPoolsCreatedByWallet,
  getSupportMatrix,
} = require('../services/uniswap.service');

const router = Router();
router.use(authenticate);

router.get('/meta', (req, res) => {
  res.json({ success: true, data: getSupportMatrix() });
});

router.post('/pools/scan', asyncHandler(async (req, res) => {
  const data = await scanPoolsCreatedByWallet({
    ...(req.body || {}),
    userId: req.user.userId,
  });
  res.json({ success: true, data });
}));

module.exports = router;

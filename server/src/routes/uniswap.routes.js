const { Router } = require('express');
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

router.post('/pools/scan', async (req, res, next) => {
  try {
    const data = await scanPoolsCreatedByWallet({
      ...(req.body || {}),
      userId: req.user.userId,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

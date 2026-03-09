/**
 * auth.routes.js
 *
 * POST /api/auth/login  → { token, user }
 * GET  /api/auth/me     → usuario actual (requiere token)
 */

const { Router } = require('express');
const authService  = require('../services/auth.service');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'username y password requeridos' });
    }
    const result = await authService.login(username, password);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ success: true, data: req.user });
});

module.exports = router;

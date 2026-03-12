/**
 * auth.routes.js
 *
 * POST /api/auth/login  → { token, user }
 * GET  /api/auth/me     → usuario actual (requiere token)
 */

const { Router } = require('express');
const authService  = require('../services/auth.service');
const { authenticate } = require('../middleware/auth.middleware');
const { ValidationError } = require('../errors/app-error');

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      throw new ValidationError('username y password requeridos');
    }
    const result = await authService.login(username, password);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ success: true, data: req.user });
});

module.exports = router;

/**
 * auth.routes.js
 *
 * POST /api/auth/login  → { token, user }
 * GET  /api/auth/me     → usuario actual (requiere token)
 */

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authService  = require('../services/auth.service');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const asyncHandler = require('../middleware/async-handler');
const { loginSchema } = require('../schemas/auth.schema');

const router = Router();

// Rate limit estricto para login: 5 intentos cada 15 minutos por IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Demasiados intentos de login, intenta de nuevo en 15 minutos' },
});

router.post('/login', loginLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const result = await authService.login(username, password);
  res.json({ success: true, data: result });
}));

router.get('/me', authenticate, (req, res) => {
  res.json({ success: true, data: req.user });
});

module.exports = router;

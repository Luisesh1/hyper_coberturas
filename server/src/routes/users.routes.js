/**
 * users.routes.js
 *
 * GET    /api/users          → lista todos (superuser)
 * POST   /api/users          → crear usuario (superuser)
 * GET    /api/users/:id      → detalle (superuser: any; user: solo self)
 * PUT    /api/users/:id      → update (superuser: any; user: solo self)
 * PUT    /api/users/:id/active → activar/desactivar (superuser)
 * PUT    /api/users/:id/role   → cambiar rol (superuser)
 */

const { Router } = require('express');
const asyncHandler = require('../middleware/async-handler');
const authService = require('../services/auth.service');
const { authenticate, requireSuperuser, requireSelfOrSuper } = require('../middleware/auth.middleware');

const router = Router();

// Todos los endpoints requieren autenticación
router.use(authenticate);

router.get('/', requireSuperuser, asyncHandler(async (req, res) => {
  const users = await authService.listUsers();
  res.json({ success: true, data: users });
}));

router.post('/', requireSuperuser, asyncHandler(async (req, res) => {
  const user = await authService.createUser(req.body);
  res.status(201).json({ success: true, data: user });
}));

router.get('/:id', requireSelfOrSuper, asyncHandler(async (req, res) => {
  const user = await authService.getUserById(parseInt(req.params.id, 10));
  res.json({ success: true, data: user });
}));

router.put('/:id', requireSelfOrSuper, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Los usuarios normales no pueden cambiar su propio rol
  const body = { ...req.body };
  if (req.user.role !== 'superuser') delete body.role;

  const user = await authService.updateUser(id, body);
  res.json({ success: true, data: user });
}));

router.put('/:id/active', requireSuperuser, asyncHandler(async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const active = Boolean(req.body.active);
  const user   = await authService.setActive(id, active);
  res.json({ success: true, data: user });
}));

router.put('/:id/role', requireSuperuser, asyncHandler(async (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const user = await authService.setRole(id, req.body.role);
  res.json({ success: true, data: user });
}));

module.exports = router;

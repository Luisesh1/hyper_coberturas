/**
 * auth.service.js
 *
 * Autenticación y gestión de usuarios.
 * - login(): verifica credenciales y devuelve JWT
 * - createUser(): crea nuevo usuario (solo superuser)
 * - updateUser(): actualiza datos de usuario
 * - setActive(): activa/desactiva usuario
 * - listUsers(): lista todos los usuarios
 * - getUserById(): obtiene usuario por ID
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../db');
const config = require('../config');
const {
  AuthError,
  NotFoundError,
  ValidationError,
} = require('../errors/app-error');

const SALT_ROUNDS = config.auth.saltRounds;

function signToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, name: user.name, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function rowToUser(row) {
  return {
    id:        row.id,
    userId:    row.id,
    username:  row.username,
    name:      row.name,
    role:      row.role,
    active:    row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getActiveUserById(id) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  const user = rows[0];
  if (!user || !user.active) {
    return null;
  }
  return rowToUser(user);
}

async function validateSessionToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch {
    throw new AuthError('Token inválido o expirado');
  }

  const user = await getActiveUserById(decoded.userId);
  if (!user) {
    throw new AuthError('Sesión inválida');
  }

  return user;
}

async function login(username, password) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE username = $1',
    [username]
  );
  const user = rows[0];

  if (!user || !user.active) {
    throw new AuthError('Credenciales inválidas');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new AuthError('Credenciales inválidas');
  }

  const token = signToken(user);
  return { token, user: rowToUser(user) };
}

async function createUser({ username, password, name, role = 'user' }) {
  if (!username || !password || !name) {
    throw new ValidationError('username, password y name son requeridos');
  }
  if (!['user', 'superuser'].includes(role)) {
    throw new ValidationError('role debe ser user o superuser');
  }

  const now  = Date.now();
  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, name, role, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $5) RETURNING *`,
      [username.trim(), hash, name.trim(), role, now]
    );
    return rowToUser(rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique violation
      throw new ValidationError('El nombre de usuario ya existe');
    }
    throw err;
  }
}

async function updateUser(id, { name, password, username }) {
  const now = Date.now();
  const updates = [];
  const values  = [];

  if (name !== undefined) {
    values.push(name.trim());
    updates.push(`name = $${values.length}`);
  }
  if (username !== undefined) {
    values.push(username.trim());
    updates.push(`username = $${values.length}`);
  }
  if (password !== undefined) {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    values.push(hash);
    updates.push(`password_hash = $${values.length}`);
  }

  if (updates.length === 0) {
    throw new ValidationError('No hay campos para actualizar');
  }

  values.push(now);
  updates.push(`updated_at = $${values.length}`);

  values.push(id);
  const { rows } = await db.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );

  if (!rows[0]) throw new NotFoundError('Usuario no encontrado');
  return rowToUser(rows[0]);
}

async function setActive(id, active) {
  const { rows } = await db.query(
    `UPDATE users SET active = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
    [active, Date.now(), id]
  );
  if (!rows[0]) throw new NotFoundError('Usuario no encontrado');
  return rowToUser(rows[0]);
}

async function setRole(id, role) {
  if (!['user', 'superuser'].includes(role)) {
    throw new ValidationError('role debe ser user o superuser');
  }
  const { rows } = await db.query(
    `UPDATE users SET role = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
    [role, Date.now(), id]
  );
  if (!rows[0]) throw new NotFoundError('Usuario no encontrado');
  return rowToUser(rows[0]);
}

async function listUsers() {
  const { rows } = await db.query(
    'SELECT * FROM users ORDER BY id ASC'
  );
  return rows.map(rowToUser);
}

async function getUserById(id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Usuario no encontrado');
  return rowToUser(rows[0]);
}

module.exports = {
  login,
  createUser,
  updateUser,
  setActive,
  setRole,
  listUsers,
  getUserById,
  getActiveUserById,
  validateSessionToken,
};

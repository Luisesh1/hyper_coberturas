/**
 * db/index.js — Pool PostgreSQL + helpers de conexión / migración
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const logger = require('../services/logger.service');
const { runMigrations } = require('./migrator');

const IS_PROD = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...(IS_PROD && { ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } }),
});

pool.on('error', (err) => logger.error('db_pool_error', { error: err.message }));

function query(text, params) {
  return pool.query(text, params);
}

async function ensureConnection() {
  await pool.query('SELECT 1');
}

async function initSchema() {
  await runMigrations(pool);
  await migrateLegacyData();
  logger.info('db_schema_initialized');
}


async function migrateLegacyData() {
  // Guard: skip si no hay datos legacy por migrar
  const { rows: orphanCheck } = await pool.query(
    'SELECT 1 FROM hedges WHERE user_id IS NULL LIMIT 1'
  );
  if (orphanCheck.length === 0) return;

  const { rows } = await pool.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  const admin = rows[0];
  if (!admin) return;

  await pool.query('UPDATE hedges SET user_id = $1 WHERE user_id IS NULL', [admin.id]);
  await pool.query('UPDATE settings SET user_id = $1 WHERE user_id IS NULL', [admin.id]);
  logger.info('legacy_data_migrated', { adminId: admin.id });
}

async function seedDevAdmin({
  username = 'admin',
  password = 'admin123',
  name = 'Administrador',
} = {}) {
  const { rows } = await pool.query('SELECT id FROM users LIMIT 1');
  if (rows.length > 0) return; // ya hay usuarios

  const now = Date.now();
  const hash = await bcrypt.hash(password, 12);
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, active, created_at, updated_at)
     VALUES ($1, $2, $3, 'superuser', true, $4, $4) RETURNING id`,
    [username, hash, name, now]
  );

  await migrateLegacyData();
  logger.info('dev_admin_seeded', { userId: admin.id, username });
  return admin;
}

/**
 * Ejecuta `fn(client)` dentro de una transacción PostgreSQL.
 * Si `fn` resuelve → COMMIT.  Si lanza → ROLLBACK + re-throw.
 * Devuelve lo que `fn` retorne.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query,
  transaction,
  ensureConnection,
  initSchema,
  migrateLegacyData,
  seedDevAdmin,
  pool,
};

/**
 * migrator.js — Ejecuta migraciones SQL versionadas desde db/migrations/.
 *
 * - Lee archivos NNN_*.sql ordenados por número
 * - Registra cada migración aplicada en la tabla `schema_migrations`
 * - Solo ejecuta migraciones pendientes
 * - Cada migración corre dentro de una transacción
 */

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger.service');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version  INTEGER PRIMARY KEY,
      name     VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedVersions(pool) {
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map((r) => r.version));
}

function loadMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) return null;
    return {
      version: parseInt(match[1], 10),
      name: match[2],
      file,
      path: path.join(MIGRATIONS_DIR, file),
    };
  }).filter(Boolean);
}

async function runMigrations(pool) {
  await ensureMigrationsTable(pool);

  const applied = await getAppliedVersions(pool);
  const migrations = loadMigrationFiles();
  let count = 0;

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    const sql = fs.readFileSync(migration.path, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );
      await client.query('COMMIT');
      count++;
      logger.info('migration_applied', { version: migration.version, name: migration.name });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('migration_failed', { version: migration.version, name: migration.name, error: err.message });
      throw err;
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    logger.info('migrations_up_to_date');
  } else {
    logger.info('migrations_complete', { applied: count });
  }
}

module.exports = { runMigrations };

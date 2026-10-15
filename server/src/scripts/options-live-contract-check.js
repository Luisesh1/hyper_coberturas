/**
 * Contrato READ-ONLY de Binance Opciones, para staging con permisos apropiados.
 * No ejecuta, cancela ni firma órdenes. No imprime API keys, posiciones ni saldos.
 *
 * Uso: node src/scripts/options-live-contract-check.js <user-id>
 */
const credentials = require('../services/options/options-credentials.service');
const db = require('../db');

async function main() {
  const userId = Number(process.argv[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Se necesita user-id entero positivo');
  }
  const client = await credentials.getClientForUser(userId);
  const now = Date.now();
  const startTime = now - 24 * 60 * 60_000;
  const endpoints = [
    ['positions', () => client.getPositions()],
    ['openOrders', () => client.getOpenOrders()],
    ['exerciseRecord', () => client.getExerciseRecords({ startTime, endTime: now, limit: 100 })],
    ['bill', () => client.getBills({ currency: 'USDT', startTime, endTime: now, limit: 100 })],
  ];
  const results = [];
  for (const [name, call] of endpoints) {
    try {
      const data = await call();
      if (!Array.isArray(data)) throw new Error('Response is not an array');
      results.push({ endpoint: name, ok: true, count: data.length,
        // Nunca volcar balances, órdenes ni identificadores de usuarios.
        shape: data.length ? Object.keys(data[0]).sort() : [] });
    } catch (err) {
      results.push({ endpoint: name, ok: false,
        code: err.code || 'UNEXPECTED_RESPONSE' });
      process.exitCode = 2;
    }
  }
  process.stdout.write(JSON.stringify({ readOnly: true, results }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write('Binance read-only contract check: ' + err.message + '\n');
  process.exitCode = 1;
}).finally(() => db.pool.end());

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('migración 051: índice (symbol, captured_at) para listBySymbols, idempotente y sin CONCURRENTLY', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/051_options_iv_snapshots_symbol_index.sql'), 'utf8');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_options_iv_snapshots_symbol_captured\s+ON options_iv_snapshots \(symbol, captured_at\);/);
  // El migrador corre cada archivo en una transacción.
  assert.doesNotMatch(sql, /CONCURRENTLY/i);
});

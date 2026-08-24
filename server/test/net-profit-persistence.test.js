const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repository = require('../src/repositories/protected-uniswap-pool.repository');

test('la migración deja policy_version nullable para preservar filas legacy', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/021_net_profit_v1_policy.sql'), 'utf8');
  assert.match(sql, /policy_version TEXT NULL/);
  assert.match(sql, /net_profit_v1/);
});

test('la migración de Net Profit V2 admite la nueva política en la base de datos', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/023_net_profit_v2_policy.sql'), 'utf8');
  assert.match(sql, /DROP CONSTRAINT IF EXISTS protected_uniswap_pools_policy_version_check/);
  assert.match(sql, /net_profit_v2/);
});

test('repository persiste policyVersion y halfWidthPct en una creación nueva', async () => {
  let params;
  await repository.create({
    userId: 1, accountId: 1, network: 'ethereum', version: 'v3', walletAddress: 'w', poolAddress: 'p', positionIdentifier: '1',
    token0Symbol: 'WETH', token1Symbol: 'USDC', rangeLowerPrice: 1900, rangeUpperPrice: 2100, priceCurrent: 2000,
    inferredAsset: 'ETH', hedgeSize: 1, hedgeNotionalUsd: 2000, configuredHedgeNotionalUsd: 2000, poolSnapshot: {}, leverage: 10,
    createdAt: 1, policyVersion: 'net_profit_v1', halfWidthPct: 5,
  }, { query: async (_sql, values) => { params = values; return { rows: [{ id: 1 }] }; } });
  // `center_dead_zone_pct` se agrego al final del INSERT, asi que policy y
  // halfWidth corrieron una posicion.
  assert.equal(params.at(-3), 'net_profit_v1');
  assert.equal(params.at(-2), 5);
  assert.equal(params.at(-1), null, 'sin valor propio hereda el default del servicio');
});

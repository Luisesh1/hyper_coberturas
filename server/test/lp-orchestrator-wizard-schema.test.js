const test = require('node:test');
const assert = require('node:assert/strict');

const { lpPlanSchema } = require('../src/schemas/lp-orchestrator.schema');

const BASE = {
  name: 'WETH/USDC',
  network: 'arbitrum',
  version: 'v4',
  walletAddress: '0xwallet',
  token0Address: '0xt0',
  token1Address: '0xt1',
  token0Symbol: 'WETH',
  token1Symbol: 'USDC',
  feeTier: 500,
  capitalUsd: 1000,
  rangeLowerPrice: 1755.7,
  rangeUpperPrice: 1956.1,
  priceCurrent: 1855.9,
  protection: { enabled: false },
};

// zod strippea las claves desconocidas en silencio: un schema que no las
// declare hace que el campo desaparezca sin error y la feature no funcione.
test('plan: conserva rangeWidthDecoupled en vez de descartarlo en silencio', () => {
  const parsed = lpPlanSchema.parse({
    ...BASE,
    strategy: { edgeMarginPct: 40, rangeWidthPct: 12, rangeWidthDecoupled: true },
  });

  assert.equal(parsed.strategy.rangeWidthDecoupled, true);
  assert.equal(parsed.strategy.rangeWidthPct, 12);
});

test('plan: conserva v4TickSpacing', () => {
  const parsed = lpPlanSchema.parse({
    ...BASE,
    strategy: { edgeMarginPct: 40, v4TickSpacing: 30 },
  });

  assert.equal(parsed.strategy.v4TickSpacing, 30);
});

test('plan: acepta v3 y v4, y rechaza cualquier otra versión', () => {
  assert.equal(lpPlanSchema.parse({ ...BASE, version: 'v3' }).version, 'v3');
  assert.equal(lpPlanSchema.parse({ ...BASE, version: 'v4' }).version, 'v4');
  assert.throws(() => lpPlanSchema.parse({ ...BASE, version: 'v2' }));
});

test('plan: recupera priceCurrent cuando un cliente anterior lo manda null', () => {
  const parsed = lpPlanSchema.parse({
    ...BASE,
    rangeLowerPrice: 1800,
    rangeUpperPrice: 2000,
    priceCurrent: null,
  });

  assert.equal(parsed.priceCurrent, 1900);
});

test('plan: rechaza un rango invertido aunque pueda calcular un centro', () => {
  assert.throws(() => lpPlanSchema.parse({
    ...BASE,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 1800,
    priceCurrent: null,
  }));
});

test('attachLpSchema acepta protectionFailureMode explicito', () => {
  const { attachLpSchema } = require('../src/schemas/lp-orchestrator.schema');
  const parsed = attachLpSchema.parse({
    finalizeResult: { txHashes: ['0xcreate'], positionChanges: { newPositionIdentifier: '191720' } },
    protectionFailureMode: 'lenient',
  });
  assert.equal(parsed.protectionFailureMode, 'lenient');
  assert.throws(() => attachLpSchema.parse({
    finalizeResult: { txHashes: ['0xcreate'], positionChanges: { newPositionIdentifier: '191720' } },
    protectionFailureMode: 'whatever',
  }));
});

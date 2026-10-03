const test = require('node:test');
const assert = require('node:assert/strict');
const { pricingMethods } = require('../src/services/protected-pool-delta-neutral/pricing');

const context = {
  _hasRealtimeMarketPrice: pricingMethods._hasRealtimeMarketPrice,
  _buildDigitalTwin: (_protection, market) => ({ eligible: true, syntheticPriceCurrent: market?.hlPrice }),
  _fetchSpot: async () => ({ priceCurrent: 102 }),
};
const protection = { poolSnapshot: { priceCurrent: 101 } };
const snapshotMeta = { snapshotFreshAt: Date.now() };

test('terminal usa cotizacion HTTP de Hyperliquid antes que el snapshot del pool', async () => {
  const result = await pricingMethods._resolvePricingContext.call(
    context, protection, snapshotMeta, { source: 'hl_http_mid', hlPrice: 100 },
    { requireHyperliquidPrice: true },
  );
  assert.equal(result.currentPrice, 100);
  assert.equal(result.spotSource, 'hl_http_mid');
});

test('terminal se detiene si falta cotizacion de Hyperliquid', async () => {
  const result = await pricingMethods._resolvePricingContext.call(
    context, protection, snapshotMeta, null, { requireHyperliquidPrice: true },
  );
  assert.equal(result.currentPrice, null);
  assert.equal(result.spotSource, 'unavailable');
});

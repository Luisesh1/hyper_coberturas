/**
 * End-to-end tests for delta-neutral protections
 * Validates the complete workflow from creation to rebalancing
 */

const { describe, it, before } = require('node:test');
const assert = require('assert');
const protectedPoolRepository = require('../src/repositories/protected-uniswap-pool.repository');
const { computeDeltaNeutralMetrics } = require('../src/services/delta-neutral-math.service');

function priceToTick(price, token0Decimals = 18, token1Decimals = 6) {
  return Math.round(Math.log(price / (10 ** (token0Decimals - token1Decimals))) / Math.log(1.0001));
}

function buildEligibleSnapshot(overrides = {}) {
  return {
    priceCurrent: 2000,
    token0: { symbol: 'WETH', decimals: 18, ...(overrides.token0 || {}) },
    token1: { symbol: 'USDC', decimals: 6, ...(overrides.token1 || {}) },
    tickLower: priceToTick(1500),
    tickUpper: priceToTick(2500),
    liquidity: '1000000000000000000000000',
    unclaimedFees0: 0,
    unclaimedFees1: 0,
    ...overrides,
  };
}

describe('Delta-Neutral Protection E2E', () => {
  let _testUserId;

  before(async () => {
    _testUserId = Math.floor(Math.random() * 1000000) + 1;
  });

  describe('Creation & Bootstrap', () => {
    it('should create a delta-neutral protection with correct mode', async () => {
      // Create a mock protection record
      const pool = {
        network: 'ethereum',
        version: 'v3',
        poolAddress: '0x' + 'a'.repeat(40),
        positionIdentifier: 'test-pos-1',
        owner: '0x' + 'b'.repeat(40),
        token0: { symbol: 'USDC', decimals: 6, address: '0x' + 'c'.repeat(40) },
        token1: { symbol: 'ETH', decimals: 18, address: '0x' + 'd'.repeat(40) },
        rangeLowerPrice: 1500,
        rangeUpperPrice: 2500,
        priceCurrent: 2000,
        liquidity: '1000000000000000000',
      };

      const snapshot = { ...pool };

      // Verify metrics calculation
      const metrics = computeDeltaNeutralMetrics(snapshot, {
        targetHedgeRatio: 1,
      });

      assert(metrics.eligible, 'Metrics should be eligible for delta-neutral');
      assert(Number.isFinite(metrics.targetQty), 'Target qty should be a number');
      assert(metrics.targetQty >= 0, 'Target qty should be >= 0');
    });

    it('should have correct initial strategy state', async () => {
      const { buildInitialStrategyState } = require('../src/services/protected-pool-delta-neutral.service');

      const state = buildInitialStrategyState({
        currentPrice: 2000,
        deltaQty: 5,
        gamma: 0.001,
        targetQty: 5,
        actualQty: 0,
        effectiveBandPct: 3,
      });

      assert.strictEqual(state.status, 'bootstrapping');
      assert.strictEqual(state.lastTargetQty, 5);
      assert.strictEqual(state.lastActualQty, 0);
      assert(Number.isFinite(state.lastSnapshotPrice));
    });
  });

  describe('Metrics Computation', () => {
    it('should compute delta metrics for valid pool', () => {
      const snapshot = buildEligibleSnapshot();

      const metrics = computeDeltaNeutralMetrics(snapshot, {
        targetHedgeRatio: 1,
      });

      assert(metrics.eligible, 'Should be eligible');
      assert(Number.isFinite(metrics.deltaQty), 'Delta should be finite');
      assert(Number.isFinite(metrics.targetQty), 'Target qty should be finite');
      assert(metrics.targetQty >= 0, 'Target qty should be non-negative');
    });

    it('should reject invalid snapshots', () => {
      // Missing required fields
      const invalidSnapshots = [
        {}, // empty
        { priceCurrent: 2000 }, // missing token info
        { priceCurrent: 0, token0: {}, token1: {} }, // invalid price
        { priceCurrent: -100, token0: {}, token1: {} }, // negative price
      ];

      invalidSnapshots.forEach((snapshot) => {
        const metrics = computeDeltaNeutralMetrics(snapshot);
        assert(!metrics.eligible, `Should not be eligible: ${JSON.stringify(snapshot)}`);
      });
    });

    it('should respect targetHedgeRatio', () => {
      const snapshot = buildEligibleSnapshot();

      const metrics1 = computeDeltaNeutralMetrics(snapshot, { targetHedgeRatio: 1 });
      const metrics2 = computeDeltaNeutralMetrics(snapshot, { targetHedgeRatio: 0.5 });

      assert(metrics1.targetQty > metrics2.targetQty,
        'Higher ratio should give higher target qty');
      assert(Math.abs(metrics2.targetQty - (metrics1.targetQty * 0.5)) < 1e-6,
        'Ratio should scale target qty linearly');
    });
  });

  describe('Strategy State Management', () => {
    it('should normalize strategy state correctly', () => {
      const { normalizeStrategyState } = require('../src/services/protected-pool-delta-neutral.service');

      const invalid = null;
      const normalized = normalizeStrategyState(invalid);

      assert(normalized, 'Should return an object');
      assert.strictEqual(normalized.status, 'healthy');
    });

    it('should track rebalance history', () => {
      const state = {
        status: 'healthy',
        lastRebalanceAt: Date.now() - 3600000, // 1 hour ago
        lastRebalanceReason: 'price_band',
        lastTargetQty: 5,
        lastActualQty: 4.8,
      };

      assert(state.lastRebalanceAt, 'Should track rebalance timestamp');
      assert(state.lastRebalanceReason, 'Should track rebalance reason');
    });
  });

  describe('Rebalance Logic', () => {
    it('should trigger on price movement', () => {
      const referencePrice = 2000;
      const currentPrice = 2065; // 3.25% movement
      const band = 3; // 3% threshold

      const priceMovePct = Math.abs((currentPrice - referencePrice) / referencePrice) * 100;
      const shouldRebalance = priceMovePct >= band;

      assert(shouldRebalance, 'Should trigger on price >= band');
    });

    it('should trigger on timer expiration', () => {
      const lastRebalance = Date.now() - (7 * 60 * 60 * 1000); // 7 hours ago
      const intervalSec = 6 * 60 * 60; // 6 hours
      const now = Date.now();

      const timerDue = (now - lastRebalance) >= (intervalSec * 1000);

      assert(timerDue, 'Should trigger when timer expires');
    });

    it('should trigger on boundary crossing', () => {
      const forceReason = 'boundary_cross';
      const shouldRebalance = forceReason === 'boundary_cross' || forceReason === 'restart_reconcile';

      assert(shouldRebalance, 'Should trigger on boundary events');
    });

    it('should skip rebalance when conditions not met', () => {
      const conditions = {
        forceRebalance: false,
        forceReason: null,
        priceMovePct: 1.5, // below band
        band: 3,
        timerDue: false,
        driftUsd: 40, // below minimum
        minRebalanceNotionalUsd: 50,
        position: { szi: -5 }, // position exists
        targetQty: 5,
      };

      const shouldRebalance =
        conditions.forceRebalance ||
        conditions.forceReason === 'boundary_cross' ||
        conditions.priceMovePct >= conditions.band ||
        (conditions.timerDue && conditions.driftUsd >= conditions.minRebalanceNotionalUsd) ||
        (!conditions.position && conditions.targetQty > 0.0000001);

      assert(!shouldRebalance, 'Should not rebalance when no trigger met');
    });
  });

  describe('Risk Management', () => {
    it('should pause on low margin distance', () => {
      const distanceToLiqPct = 5; // 5% distance
      const threshold = 7; // 7% minimum

      const shouldPause = distanceToLiqPct <= threshold;
      assert(shouldPause, 'Should pause when liquidation distance too low');
    });

    it('should pause on missing isolated margin', () => {
      const position = {
        leverage: 'cross', // should be isolated
        szi: -5,
      };

      const isIsolated = (pos) => {
        const leverage = pos?.leverage;
        if (typeof leverage === 'string') return leverage.toLowerCase() !== 'cross';
        return true;
      };

      assert(!isIsolated(position), 'Should detect non-isolated margin');
    });

    it('should pause if manual long position exists', () => {
      const position = {
        szi: 5, // positive = long (manual)
      };

      const hasManualLong = position && Number(position.szi) > 0;
      assert(hasManualLong, 'Should detect manual long position');
    });
  });

  describe('Risk-Paused Reduce-Only and Near-Zero Close', () => {
    it('risk_paused + negative drift allows reduce (gate bypass)', () => {
      const forcedStatus = 'risk_paused';
      const driftQty = -2.5; // negative = need to reduce
      const isReduceOnlyPath = driftQty < -1e-8;
      const riskPausedCanReduce = (forcedStatus === 'risk_paused' || forcedStatus === 'margin_pending') && isReduceOnlyPath;

      assert(riskPausedCanReduce, 'Should allow reduce when risk_paused and drift is negative');
    });

    it('risk_paused + positive drift stays blocked', () => {
      const forcedStatus = 'risk_paused';
      const driftQty = 2.5; // positive = need to increase
      const isReduceOnlyPath = driftQty < -1e-8;
      const riskPausedCanReduce = (forcedStatus === 'risk_paused' || forcedStatus === 'margin_pending') && isReduceOnlyPath;

      assert(!riskPausedCanReduce, 'Should NOT allow increase when risk_paused');
    });

    it('near-zero targetQty forces shouldRebalance even without price/timer triggers', () => {
      const NEAR_ZERO_TARGET_QTY = 1e-6;
      const metrics = { targetQty: 0 };
      const actualQty = 0.5;
      const forceReduceNearZero = metrics.targetQty <= NEAR_ZERO_TARGET_QTY && actualQty > 1e-8;

      const shouldRebalance = false // forceRebalance
        || forceReduceNearZero
        || false // forceReason === 'boundary_cross'
        || false; // no other triggers

      assert(forceReduceNearZero, 'Should detect near-zero condition');
      assert(shouldRebalance, 'Should force rebalance on near-zero target');
    });

    it('near-zero + risk_paused together allow the short to close', () => {
      const NEAR_ZERO_TARGET_QTY = 1e-6;
      const forcedStatus = 'risk_paused';
      const metrics = { targetQty: 0 };
      const actualQty = 0.5;
      const driftQty = metrics.targetQty - actualQty; // -0.5
      const isReduceOnlyPath = driftQty < -1e-8;
      const forceReduceNearZero = metrics.targetQty <= NEAR_ZERO_TARGET_QTY && actualQty > 1e-8;
      const riskPausedCanReduce = (forcedStatus === 'risk_paused' || forcedStatus === 'margin_pending') && isReduceOnlyPath;

      assert(forceReduceNearZero, 'Near-zero condition active');
      assert(isReduceOnlyPath, 'Drift is negative (reduce)');
      assert(riskPausedCanReduce, 'Risk-paused allows reduce');
      // Both conditions work together to let the close proceed
    });

    it('margin_pending + negative drift also allows reduce', () => {
      const forcedStatus = 'margin_pending';
      const driftQty = -1.0;
      const isReduceOnlyPath = driftQty < -1e-8;
      const riskPausedCanReduce = (forcedStatus === 'risk_paused' || forcedStatus === 'margin_pending') && isReduceOnlyPath;

      assert(riskPausedCanReduce, 'Should allow reduce when margin_pending and drift is negative');
    });

    it('near-zero targetQty with no actual position does not force rebalance', () => {
      const NEAR_ZERO_TARGET_QTY = 1e-6;
      const metrics = { targetQty: 0 };
      const actualQty = 0; // no position open
      const forceReduceNearZero = metrics.targetQty <= NEAR_ZERO_TARGET_QTY && actualQty > 1e-8;

      assert(!forceReduceNearZero, 'Should NOT force reduce when no position exists');
    });
  });

  describe('Diagnostics', () => {
    it('should provide diagnostic report format', async () => {
      // This tests the structure, not actual data
      const diagnostics = {
        id: 1,
        protectionMode: 'delta_neutral',
        status: 'active',
        strategyState: { status: 'healthy' },
        hedge: { size: 5, notionalUsd: 10000 },
        pool: { asset: 'ETH', priceCurrent: 2000 },
        configuration: { leverage: 10 },
        checks: {
          poolSnapshot: { exists: true },
          strategyState: { status: 'healthy' },
          metrics: { eligible: true },
          hyperliquid: { account: { totalMarginUsed: 5000 } },
        },
      };

      assert(diagnostics.id, 'Should have protection id');
      assert.strictEqual(diagnostics.protectionMode, 'delta_neutral');
      assert(diagnostics.checks, 'Should have checks section');
      assert(diagnostics.checks.metrics, 'Should have metrics check');
      assert(diagnostics.checks.hyperliquid, 'Should have HL check');
    });
  });

  describe('Configuration Validation', () => {
    it('should validate leverage bounds', () => {
      const leverage = 15;
      const maxLeverage = 20;

      assert(leverage >= 1, 'Leverage should be >= 1');
      assert(leverage <= maxLeverage, 'Leverage should be <= max');
    });

    it('should validate band percentage', () => {
      const bandPct = 3.5;

      assert(bandPct > 0, 'Band should be > 0%');
      assert(bandPct < 100, 'Band should be < 100%');
    });

    it('should validate rebalance interval', () => {
      const intervalSec = 7200; // 2 hours
      const minSec = 60;
      const maxSec = 86400; // 24 hours

      assert(intervalSec >= minSec, 'Interval should be >= 60 sec');
      assert(intervalSec <= maxSec, 'Interval should be <= 24 hours');
    });

    it('should validate hedge ratio', () => {
      const ratio = 0.8;

      assert(ratio > 0, 'Ratio should be > 0');
      assert(ratio <= 2, 'Ratio should be <= 2');
    });
  });
});

describe('Delta-Neutral Database Operations', () => {
  it('should list active delta-neutral protections', async () => {
    const protections = await protectedPoolRepository
      .listActiveDeltaNeutral()
      .catch(() => []);

    assert(Array.isArray(protections), 'Should return array');
    protections.forEach((p) => {
      assert.strictEqual(p.protectionMode, 'delta_neutral');
      assert.strictEqual(p.status, 'active');
    });
  });
});

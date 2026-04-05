const marketDataService = require('./market-data.service');

const STABLE_SYMBOLS = new Set([
  'USDC',
  'USDC.E',
  'USDBC',
  'USDT',
  'USDT0',
  'USD₮0',
  'DAI',
  'LUSD',
  'FDUSD',
  'USDE',
]);

const WRAPPED_TOKEN_EQUIVALENTS = new Map([
  ['WBTC', 'BTC'],
  ['WETH', 'ETH'],
]);
const TIMEFRAME_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
};

function normalizeSymbol(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  return WRAPPED_TOKEN_EQUIVALENTS.get(normalized) || normalized;
}

function isStableSymbol(value) {
  return STABLE_SYMBOLS.has(normalizeSymbol(value));
}

function normalizeEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
}

function selectRangeResolution(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '1m';
  if (durationMs <= 72 * 60 * 60 * 1000) return '1m';
  if (durationMs <= 30 * 24 * 60 * 60 * 1000) return '5m';
  if (durationMs <= 90 * 24 * 60 * 60 * 1000) return '15m';
  return '1h';
}

function isPriceInRange(price, lower, upper) {
  const numeric = Number(price);
  const a = Number(lower);
  const b = Number(upper);
  if (!Number.isFinite(numeric) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return numeric >= min && numeric <= max;
}

function resolveTrackableAsset(pool = {}) {
  const explicit = normalizeSymbol(
    pool.inferredAsset
    || pool.protectionCandidate?.inferredAsset
    || pool.protection?.inferredAsset
  );
  if (explicit) return explicit;

  const token0 = normalizeSymbol(pool.token0?.symbol || pool.token0Symbol);
  const token1 = normalizeSymbol(pool.token1?.symbol || pool.token1Symbol);
  if (!token0 || !token1) return null;
  if (isStableSymbol(token0) === isStableSymbol(token1)) return null;
  return isStableSymbol(token0) ? token1 : token0;
}

function shouldInvertPrice(pool = {}, asset) {
  const normalizedAsset = normalizeSymbol(asset);
  if (!normalizedAsset) return false;

  const base = normalizeSymbol(pool.priceBaseSymbol || pool.token0?.symbol || pool.token0Symbol);
  const quote = normalizeSymbol(pool.priceQuoteSymbol || pool.token1?.symbol || pool.token1Symbol);

  if (base === normalizedAsset && isStableSymbol(quote)) return false;
  if (quote === normalizedAsset && isStableSymbol(base)) return true;
  return false;
}

function normalizeJob(job = {}) {
  const asset = normalizeSymbol(job.asset || resolveTrackableAsset(job.pool));
  const startAt = normalizeEpochMs(job.startAt ?? job.openedAt);
  const endAt = normalizeEpochMs(job.endAt);
  const rangeLowerPrice = Number(job.rangeLowerPrice ?? job.pool?.rangeLowerPrice);
  const rangeUpperPrice = Number(job.rangeUpperPrice ?? job.pool?.rangeUpperPrice);
  const initialPrice = job.initialPrice != null ? Number(job.initialPrice) : null;
  const initialInRange = typeof job.initialInRange === 'boolean' ? job.initialInRange : null;
  const invertPrice = job.invertPrice === true || shouldInvertPrice(job.pool || {}, asset);
  const resolution = selectRangeResolution(Math.max(0, (endAt || 0) - (startAt || 0)));

  if (!asset || !startAt || !endAt || endAt <= startAt) return null;
  if (!Number.isFinite(rangeLowerPrice) || !Number.isFinite(rangeUpperPrice)) return null;
  if (initialInRange == null && !Number.isFinite(initialPrice)) return null;

  return {
    id: job.id,
    asset,
    startAt,
    endAt,
    rangeLowerPrice,
    rangeUpperPrice,
    initialPrice,
    initialInRange,
    invertPrice,
    resolution,
  };
}

function mapCandlePrice(candle = {}, invertPrice = false) {
  const close = Number(candle.close);
  if (!Number.isFinite(close) || close <= 0) return null;
  if (!invertPrice) return close;
  const inverted = 1 / close;
  return Number.isFinite(inverted) && inverted > 0 ? inverted : null;
}

function computeSegmentFromCandles({
  startAt,
  endAt,
  rangeLowerPrice,
  rangeUpperPrice,
  candles = [],
  initialPrice,
  initialInRange,
  invertPrice = false,
}) {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return null;

  let currentState = typeof initialInRange === 'boolean'
    ? initialInRange
    : isPriceInRange(initialPrice, rangeLowerPrice, rangeUpperPrice);

  if (currentState == null) return null;

  let lastAt = startAt;
  let timeInRangeMs = 0;
  let timeTrackedMs = 0;

  const sorted = Array.isArray(candles)
    ? candles
        .map((item) => ({
          closeTime: normalizeEpochMs(item.closeTime ?? item.time),
          close: Number(item.close),
        }))
        .filter((item) => Number.isFinite(item.closeTime) && item.closeTime > startAt && item.closeTime <= endAt)
        .sort((a, b) => a.closeTime - b.closeTime)
    : [];

  for (const candle of sorted) {
    const delta = Math.max(0, candle.closeTime - lastAt);
    if (delta > 0) {
      timeTrackedMs += delta;
      if (currentState) timeInRangeMs += delta;
      lastAt = candle.closeTime;
    }

    const normalizedPrice = mapCandlePrice(candle, invertPrice);
    const nextState = isPriceInRange(normalizedPrice, rangeLowerPrice, rangeUpperPrice);
    if (nextState != null) currentState = nextState;
  }

  const finalDelta = Math.max(0, endAt - lastAt);
  if (finalDelta > 0) {
    timeTrackedMs += finalDelta;
    if (currentState) timeInRangeMs += finalDelta;
  }

  return {
    timeInRangeMs,
    timeTrackedMs,
    finalInRange: currentState,
  };
}

function buildRangeMetrics({ timeInRangeMs, timeTrackedMs, rangeComputedAt, rangeResolution, lastStateInRange, rangeFrozenAt = null }) {
  const pct = timeTrackedMs > 0
    ? Number(((timeInRangeMs / timeTrackedMs) * 100).toFixed(4))
    : null;

  return {
    timeInRangeMs,
    timeTrackedMs,
    timeInRangePct: pct,
    rangeComputedAt,
    rangeResolution,
    rangeLastStateInRange: typeof lastStateInRange === 'boolean' ? lastStateInRange : null,
    rangeLastStateAt: rangeComputedAt,
    rangeFrozenAt,
  };
}

async function computeTimeInRangeBatch(jobs, deps = {}) {
  const service = deps.marketDataService || marketDataService;
  const normalizedJobs = (Array.isArray(jobs) ? jobs : [])
    .map(normalizeJob)
    .filter(Boolean);

  const result = new Map();
  if (normalizedJobs.length === 0) return result;

  const groups = new Map();
  for (const job of normalizedJobs) {
    const key = `${job.asset}:${job.resolution}`;
    const group = groups.get(key) || {
      asset: job.asset,
      resolution: job.resolution,
      startAt: job.startAt,
      endAt: job.endAt,
      jobs: [],
    };
    group.startAt = Math.min(group.startAt, job.startAt);
    group.endAt = Math.max(group.endAt, job.endAt);
    group.jobs.push(job);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    let candles = [];
    try {
      candles = await service.getCandles(group.asset, group.resolution, {
        startTime: group.startAt,
        endTime: group.endAt,
      });
    } catch {
      candles = [];
    }

    for (const job of group.jobs) {
      const resolutionMs = TIMEFRAME_MS[job.resolution] || 60_000;
      const hasJobCandles = Array.isArray(candles)
        && candles.some((item) => {
          const closeTime = normalizeEpochMs(item.closeTime ?? item.time);
          return Number.isFinite(closeTime) && closeTime > job.startAt && closeTime <= job.endAt;
        });
      if (!hasJobCandles && (job.endAt - job.startAt) > resolutionMs) {
        result.set(job.id, null);
        continue;
      }

      const segment = computeSegmentFromCandles({
        ...job,
        candles,
      });
      if (!segment) {
        result.set(job.id, null);
        continue;
      }
      result.set(job.id, buildRangeMetrics({
        timeInRangeMs: segment.timeInRangeMs,
        timeTrackedMs: segment.timeTrackedMs,
        rangeComputedAt: job.endAt,
        rangeResolution: job.resolution,
        lastStateInRange: segment.finalInRange,
      }));
    }
  }

  return result;
}

async function annotatePoolsWithTimeInRange(pools, deps = {}) {
  const items = Array.isArray(pools) ? pools : [];
  const now = normalizeEpochMs(deps.endAt || Date.now()) || Date.now();
  const jobs = [];

  for (let index = 0; index < items.length; index += 1) {
    const pool = items[index];
    if (pool?.mode !== 'lp_position' || !['v3', 'v4'].includes(pool?.version)) continue;
    jobs.push({
      id: String(index),
      pool,
      asset: resolveTrackableAsset(pool),
      openedAt: pool.openedAt || pool.createdAt,
      endAt: pool.rangeFrozenAt || now,
      rangeLowerPrice: pool.rangeLowerPrice,
      rangeUpperPrice: pool.rangeUpperPrice,
      initialPrice: pool.priceAtOpen,
      invertPrice: shouldInvertPrice(pool, resolveTrackableAsset(pool)),
    });
  }

  const metricsMap = await computeTimeInRangeBatch(jobs, deps);

  return items.map((pool, index) => {
    const metrics = metricsMap.get(String(index)) || null;
    if (!metrics) {
      return {
        ...pool,
        timeInRangePct: null,
        timeInRangeMs: null,
        timeTrackedMs: null,
        rangeComputedAt: null,
        rangeResolution: null,
      };
    }
    return {
      ...pool,
      timeInRangePct: metrics.timeInRangePct,
      timeInRangeMs: metrics.timeInRangeMs,
      timeTrackedMs: metrics.timeTrackedMs,
      rangeComputedAt: metrics.rangeComputedAt,
      rangeResolution: metrics.rangeResolution,
    };
  });
}

function applyRangeMetricsToSnapshot(snapshot, metrics) {
  if (!snapshot || typeof snapshot !== 'object' || !metrics) return snapshot;
  return {
    ...snapshot,
    timeInRangePct: metrics.timeInRangePct,
    timeInRangeMs: metrics.timeInRangeMs,
    timeTrackedMs: metrics.timeTrackedMs,
    rangeComputedAt: metrics.rangeComputedAt,
    rangeResolution: metrics.rangeResolution,
    rangeFrozenAt: metrics.rangeFrozenAt ?? null,
  };
}

async function computeRangeMetricsForPool(pool, deps = {}) {
  const endAt = normalizeEpochMs(deps.endAt || Date.now());
  const asset = normalizeSymbol(deps.asset || resolveTrackableAsset(pool));
  const metricsMap = await computeTimeInRangeBatch([{
    id: 'pool',
    pool,
    asset,
    openedAt: pool?.openedAt || pool?.createdAt,
    endAt,
    rangeLowerPrice: pool?.rangeLowerPrice,
    rangeUpperPrice: pool?.rangeUpperPrice,
    initialPrice: pool?.priceAtOpen,
    invertPrice: shouldInvertPrice(pool || {}, asset),
  }], deps);

  return metricsMap.get('pool') || null;
}

async function computeIncrementalRangeMetrics(protection, deps = {}) {
  const endAt = normalizeEpochMs(deps.endAt || Date.now());
  const snapshot = deps.poolSnapshot || protection?.poolSnapshot || {};
  const asset = normalizeSymbol(deps.asset || protection?.inferredAsset || resolveTrackableAsset(snapshot));
  const baseTimeInRangeMs = Number(protection?.timeInRangeMs || 0);
  const baseTimeTrackedMs = Number(protection?.timeTrackedMs || 0);

  if (!asset || !endAt) return null;

  if (protection?.rangeLastStateAt && typeof protection?.rangeLastStateInRange === 'boolean') {
    const metricsMap = await computeTimeInRangeBatch([{
      id: 'delta',
      pool: snapshot,
      asset,
      startAt: protection.rangeLastStateAt,
      endAt,
      rangeLowerPrice: protection.rangeLowerPrice ?? snapshot.rangeLowerPrice,
      rangeUpperPrice: protection.rangeUpperPrice ?? snapshot.rangeUpperPrice,
      initialInRange: protection.rangeLastStateInRange,
      invertPrice: shouldInvertPrice(snapshot, asset) || shouldInvertPrice(protection, asset),
    }], deps);
    const delta = metricsMap.get('delta');
    if (!delta) return null;

    return buildRangeMetrics({
      timeInRangeMs: baseTimeInRangeMs + delta.timeInRangeMs,
      timeTrackedMs: baseTimeTrackedMs + delta.timeTrackedMs,
      rangeComputedAt: endAt,
      rangeResolution: delta.rangeResolution,
      lastStateInRange: delta.rangeLastStateInRange,
      rangeFrozenAt: deps.rangeFrozenAt ?? null,
    });
  }

  const fullMetrics = await computeRangeMetricsForPool({
    ...snapshot,
    token0Symbol: protection?.token0Symbol ?? snapshot.token0Symbol,
    token1Symbol: protection?.token1Symbol ?? snapshot.token1Symbol,
    inferredAsset: asset,
  }, {
    ...deps,
    asset,
    endAt,
  });

  if (!fullMetrics) return null;

  return {
    ...fullMetrics,
    rangeFrozenAt: deps.rangeFrozenAt ?? fullMetrics.rangeFrozenAt ?? null,
  };
}

module.exports = {
  annotatePoolsWithTimeInRange,
  applyRangeMetricsToSnapshot,
  buildRangeMetrics,
  computeIncrementalRangeMetrics,
  computeRangeMetricsForPool,
  computeSegmentFromCandles,
  computeTimeInRangeBatch,
  isPriceInRange,
  normalizeEpochMs,
  normalizeSymbol,
  resolveTrackableAsset,
  selectRangeResolution,
  shouldInvertPrice,
};

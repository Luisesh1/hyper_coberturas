export function buildBot(overrides = {}) {
  const base = {
    id: 21,
    strategyId: 11,
    strategyName: 'Trend Rider',
    accountId: 1,
    account: {
      id: 1,
      alias: 'Cuenta Alpha',
      address: '0x00000000000000000000000000000000000000AA',
      shortAddress: '0x0000...00AA',
    },
    asset: 'BTC',
    timeframe: '15m',
    params: { fastPeriod: 9 },
    leverage: 10,
    marginMode: 'cross',
    size: 0.01,
    stopLossPct: 1.5,
    takeProfitPct: 3,
    status: 'draft',
    lastSignal: null,
    lastError: null,
    lastEvaluatedAt: 1710000000000,
    lastCandleAt: 1710000000000,
    runtime: {
      state: 'healthy',
      consecutiveFailures: 0,
      nextRetryAt: null,
      lastRecoveryAt: null,
      lastRecoveryAction: null,
      systemPauseReason: null,
      context: {},
    },
  };

  return {
    ...base,
    ...overrides,
    account: {
      ...base.account,
      ...(overrides.account || {}),
    },
    runtime: {
      ...base.runtime,
      ...(overrides.runtime || {}),
    },
  };
}

export function buildRun(overrides = {}) {
  const base = {
    id: 1,
    action: 'hold',
    status: 'success',
    signal: { type: 'hold' },
    price: 100000,
    details: {},
    createdAt: 1710000000000,
  };

  return {
    ...base,
    ...overrides,
    signal: Object.prototype.hasOwnProperty.call(overrides, 'signal')
      ? overrides.signal
      : base.signal,
    details: {
      ...base.details,
      ...(overrides.details || {}),
    },
  };
}

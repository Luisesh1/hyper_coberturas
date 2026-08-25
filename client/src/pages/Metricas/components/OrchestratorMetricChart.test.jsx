import { describe, expect, it } from 'vitest';
import { selectPolicySnapshot } from './OrchestratorMetricChart';

const snapshot = {
  capturedAt: 1,
  walletUsd: 10,
  lpUsd: 20,
  hlAccountUsd: 70,
  totalUsd: 100,
  breakdown: {
    accounting: {
      lpFeesUsd: 4, priceDriftUsd: 2, gasSpentUsd: 1, swapSlippageUsd: 1,
      hedgeRealizedPnlUsd: 3, hedgeUnrealizedPnlUsd: 1, hedgeFundingUsd: 0,
      hedgeExecutionFeesUsd: 0.5, hedgeSlippageUsd: 0.5, totalNetPnlUsd: 7,
    },
    policies: {
      legacy_zones_v1: {
        isLive: true, hlAccountUsd: 70,
        hedgeRealizedPnlUsd: 3, hedgeUnrealizedPnlUsd: 1, hedgeFundingUsd: 0,
        hedgeExecutionFeesUsd: 0.5, hedgeSlippageUsd: 0.5,
      },
      net_profit_v1: {
        isLive: false, hlAccountUsd: 75,
        hedgeRealizedPnlUsd: 8, hedgeUnrealizedPnlUsd: 1, hedgeFundingUsd: 0,
        hedgeExecutionFeesUsd: 0.5, hedgeSlippageUsd: 0.5,
      },
      net_profit_v2: { isLive: false, hlAccountUsd: null },
    },
  },
};

describe('selectPolicySnapshot', () => {
  it('mantiene exactamente la vista viva y cambia sólo la pata hedge de una alternativa', () => {
    const live = selectPolicySnapshot(snapshot, 'live');
    const shadow = selectPolicySnapshot(snapshot, 'net_profit_v1');
    expect(live.totalUsd).toBe(100);
    expect(live.breakdown.accounting.totalNetPnlUsd).toBe(7);
    expect(shadow.walletUsd).toBe(10);
    expect(shadow.lpUsd).toBe(20);
    expect(shadow.totalUsd).toBe(105);
    expect(shadow.breakdown.accounting.lpFeesUsd).toBe(4);
    expect(shadow.breakdown.accounting.priceDriftUsd).toBe(2);
    expect(shadow.breakdown.accounting.totalNetPnlUsd).toBe(12);
  });

  it('representa una política ausente como hueco, nunca como cero', () => {
    expect(selectPolicySnapshot(snapshot, 'net_profit_v2')).toBeNull();
    expect(selectPolicySnapshot({ ...snapshot, breakdown: {} }, 'net_profit_v1')).toBeNull();
  });
});

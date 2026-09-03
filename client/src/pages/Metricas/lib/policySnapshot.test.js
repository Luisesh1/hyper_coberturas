import { describe, expect, it } from 'vitest';
import { POLICY_OPTIONS, selectPolicySnapshot } from './policySnapshot';

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
      range_exit_v1: {
        isLive: false, hlAccountUsd: 72,
        hedgeRealizedPnlUsd: 5, hedgeUnrealizedPnlUsd: 0, hedgeFundingUsd: 0,
        hedgeExecutionFeesUsd: 0.05, hedgeSlippageUsd: 0,
      },
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

  it('la sombra de borde de rango se puede seleccionar y comparar', () => {
    // Corre solo en sombra, asi que nunca aparece en el selector de la
    // proteccion — pero tiene que ser comparable aca, que es para lo que
    // existe. Sin esto la politica corre y nadie puede verla.
    expect(POLICY_OPTIONS.map((o) => o.value)).toContain('range_exit_v1');
    const shadow = selectPolicySnapshot(snapshot, 'range_exit_v1');
    expect(shadow).not.toBeNull();
    expect(shadow.totalUsd).toBe(102);
    // Solo cambia la pata hedge: LP y wallet son los mismos que en la viva.
    expect(shadow.lpUsd).toBe(20);
    expect(shadow.walletUsd).toBe(10);
  });

  it('los snapshots anteriores al alta de una politica quedan como hueco', () => {
    // Todo lo capturado antes del deploy no trae `range_exit_v1`: la serie
    // tiene que arrancar el dia que se desplego, no rellenarse con ceros.
    const previo = { ...snapshot, breakdown: { ...snapshot.breakdown, policies: { legacy_zones_v1: snapshot.breakdown.policies.legacy_zones_v1 } } };
    expect(selectPolicySnapshot(previo, 'range_exit_v1')).toBeNull();
  });

  it('representa una política ausente como hueco, nunca como cero', () => {
    expect(selectPolicySnapshot(snapshot, 'net_profit_v2')).toBeNull();
    expect(selectPolicySnapshot({ ...snapshot, breakdown: {} }, 'net_profit_v1')).toBeNull();
  });
});

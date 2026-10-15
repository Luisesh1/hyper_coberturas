import { describe, expect, it } from 'vitest';
import { buildRedeployResume } from './redeployResume';

const H = (n) => `0x${String(n).repeat(64)}`;

const PLAN = {
  txPlan: [
    { kind: 'decrease_liquidity_v4' },
    { kind: 'approval' },
    { kind: 'swap_v4' },
    { kind: 'mint_position_v4' },
  ],
  quoteSummary: {
    resumed: false,
    redeployFunding: { amount0Raw: '100', amount1Raw: '200' },
    postSwapFunding: { amount0Raw: '150', amount1Raw: '120' },
  },
};

describe('buildRedeployResume', () => {
  it('sin el retiro minado no hay nada que retomar: se vuelve a preparar entero', () => {
    expect(buildRedeployResume({ action: 'modify-range', prepareData: PLAN, completed: 0, txHashes: [] })).toBeNull();
  });

  it('con el retiro minado retoma con lo que libero el retiro', () => {
    expect(buildRedeployResume({
      action: 'modify-range', prepareData: PLAN, completed: 2, txHashes: [H(1), H(2), H(3)],
    })).toEqual({
      resumeFunding: { amount0Raw: '100', amount1Raw: '200' },
      priorTxHashes: [H(1), H(2)],
    });
  });

  it('si el swap tambien se mino, retoma con los saldos posteriores al swap', () => {
    expect(buildRedeployResume({
      action: 'rebalance', prepareData: PLAN, completed: 3, txHashes: [H(1), H(2), H(3), H(4)],
    })).toEqual({
      resumeFunding: { amount0Raw: '150', amount1Raw: '120' },
      priorTxHashes: [H(1), H(2), H(3)],
    });
  });

  it('un plan ya retomado que vuelve a fallar acumula los hashes y conserva el capital', () => {
    const previous = { resumeFunding: { amount0Raw: '100', amount1Raw: '200' }, priorTxHashes: [H(1)] };
    const resumedPlan = {
      txPlan: [{ kind: 'swap_v4' }, { kind: 'mint_position_v4' }],
      quoteSummary: { ...PLAN.quoteSummary, resumed: true },
    };
    expect(buildRedeployResume({
      action: 'modify-range', prepareData: resumedPlan, completed: 0, txHashes: [], previous,
    })).toEqual(previous);
    expect(buildRedeployResume({
      action: 'modify-range', prepareData: resumedPlan, completed: 1, txHashes: [H(5)], previous,
    })).toEqual({
      resumeFunding: { amount0Raw: '150', amount1Raw: '120' },
      priorTxHashes: [H(1), H(5)],
    });
  });

  it('otras acciones no se retoman', () => {
    expect(buildRedeployResume({ action: 'close-to-usdc', prepareData: PLAN, completed: 2, txHashes: [] })).toBeNull();
  });

  it('un servidor viejo sin redeployFunding no permite retomar', () => {
    const legacy = { ...PLAN, quoteSummary: { resumed: false } };
    expect(buildRedeployResume({ action: 'modify-range', prepareData: legacy, completed: 1, txHashes: [H(1)] })).toBeNull();
  });
});

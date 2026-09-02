import { describe, expect, it } from 'vitest';
import { getOrchestratorSeverity, buildActionQueue, sortBySeverity } from './orchestratorSeverity';

const base = (over = {}) => ({
  id: 1,
  token0Symbol: 'ETH',
  token1Symbol: 'USDC',
  activePositionIdentifier: 'pos-1',
  ...over,
});

const sano = base({ id: 10, phase: 'lp_active' });
const rebalanceo = base({ id: 11, phase: 'needs_rebalance' });
const fueraDeRango = base({ id: 12, phase: 'urgent_adjust' });
const sinLp = base({ id: 13, phase: 'idle', activePositionIdentifier: null });

describe('getOrchestratorSeverity', () => {
  it('mapea el tono del diagnóstico ya existente', () => {
    expect(getOrchestratorSeverity(sano)).toBe('ok');
    expect(getOrchestratorSeverity(rebalanceo)).toBe('warn');
    expect(getOrchestratorSeverity(fueraDeRango)).toBe('urgent');
    expect(getOrchestratorSeverity(sinLp)).toBe('idle');
    expect(getOrchestratorSeverity(null)).toBe('idle');
  });
});

describe('buildActionQueue', () => {
  it('deja fuera lo sano y ordena lo grave primero', () => {
    const cola = buildActionQueue([sano, rebalanceo, fueraDeRango, sinLp]);
    expect(cola.map((c) => c.id)).toEqual([12, 11]);
    expect(cola[0].severity).toBe('urgent');
    expect(cola[0].issue.title).toBeTruthy();
    expect(cola[0].pair).toBe('ETH/USDC');
  });

  it('con todo sano la cola queda vacía', () => {
    // La cola vale por lo que deja afuera: si apareciera siempre, sería otra
    // franja de ruido en vez de una lista de trabajo.
    expect(buildActionQueue([sano, sinLp])).toEqual([]);
    expect(buildActionQueue([])).toEqual([]);
  });
});

describe('sortBySeverity', () => {
  it('sube lo urgente sin barajar el resto', () => {
    const orden = sortBySeverity([sano, rebalanceo, fueraDeRango, sinLp]).map((o) => o.id);
    expect(orden).toEqual([12, 11, 10, 13]);
  });

  it('dentro del mismo nivel conserva el orden recibido', () => {
    // Sin esto las tarjetas saltarían de lugar en cada refresco de 30 s.
    const a = base({ id: 20, phase: 'lp_active' });
    const b = base({ id: 21, phase: 'lp_active' });
    expect(sortBySeverity([b, a]).map((o) => o.id)).toEqual([21, 20]);
  });
});

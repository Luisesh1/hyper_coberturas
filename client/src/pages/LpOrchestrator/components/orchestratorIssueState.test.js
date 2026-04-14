import { describe, expect, it } from 'vitest';
import { getOrchestratorIssue } from './orchestratorIssueState';

function makeOrchestrator(overrides = {}) {
  return {
    id: 19,
    phase: 'lp_active',
    lastError: null,
    lastDecision: 'hold',
    lastEvaluationAt: 1_710_000_000_000,
    nextEligibleAttemptAt: null,
    cooldownReason: null,
    lastEvaluation: null,
    ...overrides,
  };
}

describe('getOrchestratorIssue', () => {
  it('prioriza failed y expone el error tecnico', () => {
    const issue = getOrchestratorIssue(makeOrchestrator({
      phase: 'failed',
      lastError: 'verification_failed:range_mismatch',
    }), 1_710_000_100_000);

    expect(issue).toEqual(expect.objectContaining({
      kind: 'failed',
      chipLabel: 'Error critico',
    }));
    expect(issue.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Detalle tecnico', value: 'verification_failed:range_mismatch' }),
    ]));
  });

  it('marca cooldown cuando el siguiente intento sigue en el futuro', () => {
    const issue = getOrchestratorIssue(makeOrchestrator({
      nextEligibleAttemptAt: 1_710_000_120_000,
      cooldownReason: 'scan_failed',
    }), 1_710_000_100_000);

    expect(issue).toEqual(expect.objectContaining({
      kind: 'cooldown',
      chipLabel: 'Cooldown',
      resolveLabel: 'Forzar reevaluacion',
    }));
  });

  it('no genera chip cuando el orquestador esta sano', () => {
    expect(getOrchestratorIssue(makeOrchestrator(), 1_710_000_100_000)).toBeNull();
  });
});

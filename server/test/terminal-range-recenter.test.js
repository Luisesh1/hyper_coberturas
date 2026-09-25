const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMINAL_RECENTER_MIN_COOLDOWN_SEC,
  resolveTerminalRecenterDecision,
} = require('../src/services/lp-orchestrator/terminal-recenter');

const H = 3_600_000;
const NOW = 1_700_000_000_000;

const terminalProtection = (openedAt) => ({
  policyVersion: 'terminal_range_v1',
  strategyState: { executionIntent: 'live', terminalRangePolicyState: { openedAt } },
});

test('solo aplica a orquestadores con terminal viva', () => {
  const inRange = { inRange: true, outOfRangeSide: null };
  assert.equal(resolveTerminalRecenterDecision({ protection: null, evaluation: inRange, now: NOW }), null);
  assert.equal(resolveTerminalRecenterDecision({
    protection: { policyVersion: 'range_exit_v1', strategyState: { executionIntent: 'live' } },
    evaluation: inRange,
    now: NOW,
  }), null);
  // Declarada en sombra: la viva es legacy y sus reglas no cambian.
  assert.equal(resolveTerminalRecenterDecision({
    protection: { policyVersion: 'terminal_range_v1', strategyState: { executionIntent: 'shadow' } },
    evaluation: inRange,
    now: NOW,
  }), null);
});

test('dentro del rango no recomienda recentrar: el ciclo solo termina fuera', () => {
  const d = resolveTerminalRecenterDecision({
    protection: terminalProtection(NOW - 30 * H),
    evaluation: { inRange: true },
    now: NOW,
  });
  assert.deepEqual(d, { decision: 'hold', reason: 'terminal_in_range' });
});

test('fuera del rango antes de 24 h desde la apertura: espera', () => {
  const d = resolveTerminalRecenterDecision({
    protection: terminalProtection(NOW - 23 * H),
    evaluation: { inRange: false, outOfRangeSide: 'below' },
    now: NOW,
  });
  assert.equal(d.decision, 'hold');
  assert.equal(d.reason, 'out_of_range_below_terminal_cooldown');
  assert.equal(d.eligibleAt, NOW + H);
});

test('fuera del rango y cumplido el plazo: recentrado urgente', () => {
  const d = resolveTerminalRecenterDecision({
    protection: terminalProtection(NOW - 25 * H),
    evaluation: { inRange: false, outOfRangeSide: 'above' },
    now: NOW,
  });
  assert.deepEqual(d, { decision: 'urgent_adjust', reason: 'out_of_range_above' });
});

test('el plazo configurado solo puede alargar las 24 h del perfil', () => {
  assert.equal(TERMINAL_RECENTER_MIN_COOLDOWN_SEC, 86_400);
  const larga = resolveTerminalRecenterDecision({
    protection: terminalProtection(NOW - 30 * H),
    evaluation: { inRange: false, outOfRangeSide: 'below' },
    cooldownSec: 48 * 3600,
    now: NOW,
  });
  assert.equal(larga.decision, 'hold');
  const corta = resolveTerminalRecenterDecision({
    protection: terminalProtection(NOW - 2 * H),
    evaluation: { inRange: false, outOfRangeSide: 'below' },
    cooldownSec: 3600,
    now: NOW,
  });
  assert.equal(corta.decision, 'hold', 'el default historico de 1 h no acorta el perfil');
});

test('sin apertura registrada no se inventa el plazo: se permite recentrar', () => {
  const d = resolveTerminalRecenterDecision({
    protection: terminalProtection(undefined),
    evaluation: { inRange: false, outOfRangeSide: 'below' },
    now: NOW,
  });
  assert.equal(d.decision, 'urgent_adjust');
});

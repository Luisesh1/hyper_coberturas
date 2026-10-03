const test = require('node:test');
const assert = require('node:assert/strict');

const { fundingReceivedUsd, accumulateFundingUsd } = require('../src/utils/hl-funding');

// Hyperliquid publica `cumFunding` desde el lado del que PAGA: positivo =
// pagado. Verificado el 2026-09-25 contra `userFunding` (donde `delta.usdc < 0`
// es pagado) en posiciones reales: sinceChange == -Σ usdc al sexto decimal
// (SOL short +1.536873 recibido -> sinceChange -1.536873; ETH long -62.915903
// pagado -> sinceChange +62.915903). El servidor entero trabaja con
// "positivo = recibido", asi que la conversion vive en un solo sitio.
test('fundingReceivedUsd invierte el signo de cumFunding (positivo = recibido)', () => {
  assert.equal(fundingReceivedUsd({ cumFunding: { sinceOpen: '62.915903' } }), -62.915903);
  assert.equal(fundingReceivedUsd({ cumFunding: { sinceOpen: '-1.536873' } }), 1.536873);
  assert.equal(fundingReceivedUsd({ cumFunding: { sinceOpen: '0.0' } }), 0);
});

test('fundingReceivedUsd devuelve null si no hay dato utilizable', () => {
  assert.equal(fundingReceivedUsd(null), null);
  assert.equal(fundingReceivedUsd({}), null);
  assert.equal(fundingReceivedUsd({ cumFunding: {} }), null);
  assert.equal(fundingReceivedUsd({ cumFunding: { sinceOpen: 'abc' } }), null);
});

test('el funding del ciclo no se reinicia al cerrar y reabrir el short', () => {
  const first = accumulateFundingUsd({
    cumFunding: { allTime: '10', sinceOpen: '2' },
  }, { fundingAccumUsd: 0 });
  assert.equal(first.fundingAccumUsd, -2);

  const closed = accumulateFundingUsd(null, first);
  assert.equal(closed.fundingAccumUsd, -2);

  const reopened = accumulateFundingUsd({
    cumFunding: { allTime: '12', sinceOpen: '0.5' },
  }, closed);
  assert.equal(reopened.fundingAccumUsd, -4);
});

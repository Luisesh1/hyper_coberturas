const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UNDERLYINGS,
  formatExpiryCode,
  parseExpiryCode,
  formatStrike,
  buildInstrumentName,
  parseInstrumentName,
  fridaysBetween,
} = require('../src/services/deribit/deribit-instruments');

test('formatExpiryCode: dia sin cero, mes en mayusculas, anio en 2 digitos', () => {
  assert.equal(formatExpiryCode(Date.UTC(2025, 9, 31, 8)), '31OCT25');
  assert.equal(formatExpiryCode(Date.UTC(2026, 9, 9, 8)), '9OCT26');
});

test('parseExpiryCode: devuelve el vencimiento a las 08:00 UTC', () => {
  assert.equal(parseExpiryCode('5DEC25'), Date.UTC(2025, 11, 5, 8));
});

test('formatStrike: el decimal se escribe con d', () => {
  assert.equal(formatStrike(2.2), '2d2');
  assert.equal(formatStrike(4000), '4000');
  assert.equal(formatStrike(0.105), '0d105');
});

test('buildInstrumentName: subyacente USDC usa prefijo <X>_USDC', () => {
  assert.equal(
    buildInstrumentName({ underlying: 'XRP', expiryMs: Date.UTC(2025, 11, 5, 8), strike: 2.2, type: 'C' }),
    'XRP_USDC-5DEC25-2d2-C',
  );
});

test('parseInstrumentName: contrato inverso ETH', () => {
  assert.deepEqual(parseInstrumentName('ETH-31OCT25-4000-C'), {
    underlying: 'ETH',
    prefix: 'ETH',
    expiryCode: '31OCT25',
    expiryMs: Date.UTC(2025, 9, 31, 8),
    strike: 4000,
    type: 'C',
    inverse: true,
  });
});

test('parseInstrumentName: contrato USDC no es inverso', () => {
  assert.equal(parseInstrumentName('SOL_USDC-21NOV25-140-P').inverse, false);
});

test('parseInstrumentName: un perpetuo no es un vencimiento', () => {
  assert.equal(parseInstrumentName('ETH-PERPETUAL'), null);
});

test('parseInstrumentName: fecha inexistente se rechaza', () => {
  assert.equal(parseInstrumentName('ETH-31FEB25-4000-C'), null);
});

test('UNDERLYINGS: BNB y DOGE no cotizan en Deribit', () => {
  assert.equal(UNDERLYINGS.BNB, undefined);
  assert.equal(UNDERLYINGS.DOGE, undefined);
});

test('UNDERLYINGS: binanceSymbol, pasos de strike y perpetuos', () => {
  assert.equal(UNDERLYINGS.ETH.binanceSymbol, 'ETHUSDT');
  assert.equal(UNDERLYINGS.ETH.perpetual, 'ETH-PERPETUAL');
  assert.equal(UNDERLYINGS.BTC.perpetual, 'BTC-PERPETUAL');
  assert.deepEqual(UNDERLYINGS.ETH.strikeSteps, [50, 25, 100]);
  assert.deepEqual(UNDERLYINGS.TRX.strikeSteps, [0.01, 0.005]);
  assert.equal(UNDERLYINGS.SOL.prefix, 'SOL_USDC');
  assert.equal(UNDERLYINGS.SOL.currency, 'USDC');
  assert.equal(UNDERLYINGS.SOL.inverse, false);
});

test('fridaysBetween: viernes a las 08:00 UTC dentro del rango', () => {
  assert.deepEqual(
    fridaysBetween(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 21)),
    [Date.UTC(2026, 9, 2, 8), Date.UTC(2026, 9, 9, 8), Date.UTC(2026, 9, 16, 8)],
  );
});

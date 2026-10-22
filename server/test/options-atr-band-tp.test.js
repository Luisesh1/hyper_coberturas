const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/atr-bands.json');
const { wilderAtrBands, atrBandTakeProfit } = require('../src/services/options/options-atr-band-tp');
const { createOptionsMarketService } = require('../src/services/options/options-market.service');
const { createBinanceOptionsClient } = require('../src/services/options/binance-options.client');

const lastClose = fixture.rows.at(-1)[6];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const opts = { tickSize: 0.1, minPrice: 0.1, maxGainPct: 200 };

test('paridad con computeAtrBands del cliente (fixture)', () => {
  const band = wilderAtrBands(fixture.rows, { length: fixture.length, multiplier: fixture.multiplier, now: lastClose + 1 });
  near(band.upper, fixture.expected.upper);
  near(band.lower, fixture.expected.lower);
  near(band.atr, fixture.expected.atr);
  assert.equal(band.close, fixture.expected.close);
});

test('la vela en curso (closeTime >= now) no se usa', () => {
  const band = wilderAtrBands(fixture.rows, { length: 14, multiplier: 2, now: lastClose });
  assert.equal(band.close, Number(fixture.rows.at(-2)[4]));
  assert.equal(wilderAtrBands(fixture.rows.slice(0, 14), { now: lastClose + 1 }), null);
});

test('ejemplo del usuario: call 40 / spot 3000 / banda 3060', () => {
  const r = atrBandTakeProfit({ fillPrice: 40, spot: 3000, type: 'C', band: { upper: 3060 }, ...opts });
  near(r.distancePct, 2); near(r.leverage, 75); near(r.rawGainPct, 150);
  assert.equal(r.price, 100); assert.equal(r.capped, false); assert.equal(r.bandValue, 3060);
});

test('tope de ganancia', () => {
  const r = atrBandTakeProfit({ fillPrice: 10, spot: 3000, type: 'C', band: { upper: 3060 }, ...opts });
  near(r.rawGainPct, 600); assert.equal(r.appliedGainPct, 200);
  assert.equal(r.price, 30); assert.equal(r.capped, true);
});

test('put usa la banda inferior', () => {
  const r = atrBandTakeProfit({ fillPrice: 40, spot: 3000, type: 'P', band: { lower: 2940 }, ...opts });
  near(r.distancePct, 2); assert.equal(r.price, 100);
});

test('spot más allá de la banda: distancia desde el último cierre', () => {
  const band = { upper: 3060, close: 3000, atr: 30, multiplier: 2 };
  const r = atrBandTakeProfit({ fillPrice: 40, spot: 3070, type: 'C', band, ...opts });
  near(r.distancePct, 2);
});

test('redondea hacia arriba al tick anclado en minPrice', () => {
  const r = atrBandTakeProfit({ fillPrice: 40, spot: 3000, type: 'C',
    band: { upper: 3061.2 }, tickSize: 0.5, minPrice: 0.5, maxGainPct: 500 });
  // 40 * (1 + 2.04 * 75 / 100) = 101.2 -> 101.5
  assert.equal(r.price, 101.5);
  const q = atrBandTakeProfit({ fillPrice: 40, spot: 3000, type: 'C', band: { upper: 3060 }, tickSize: 0.5, minPrice: 0.02, maxGainPct: 200 });
  assert.equal(q.price, 100.02);
});

test('entradas inválidas devuelven null', () => {
  assert.equal(atrBandTakeProfit({ fillPrice: 0, spot: 3000, type: 'C', band: { upper: 3060 }, ...opts }), null);
  assert.equal(atrBandTakeProfit({ fillPrice: 40, spot: 3000, type: 'X', band: { upper: 3060 }, ...opts }), null);
});

test('getSpotKlines acepta 5m–1d y hasta 500 velas', () => {
  const c = createBinanceOptionsClient({});
  assert.throws(() => c.getSpotKlines('BTCUSDT', '2h', 200), /inválidos/);
  assert.throws(() => c.getSpotKlines('BTCUSDT', '1h', 501), /inválidos/);
});

test('market.getAtrBand pide max(200, length*10) velas y cachea 60 s', async () => {
  let calls = 0; let t = lastClose + 1;
  const service = createOptionsMarketService({ now: () => t, client: {
    async getSpotKlines(pair, interval, limit) {
      assert.equal(pair, 'ETHUSDT'); assert.equal(interval, '4h'); assert.equal(limit, 200);
      calls++; return fixture.rows;
    },
  } });
  const a = await service.getAtrBand('ETH', { interval: '4h', length: 14, multiplier: 2 });
  near(a.upper, fixture.expected.upper);
  await service.getAtrBand('ETH', { interval: '4h', length: 14, multiplier: 2 });
  assert.equal(calls, 1);
  t += 61_000;
  await service.getAtrBand('ETH', { interval: '4h', length: 14, multiplier: 2 });
  assert.equal(calls, 2);
});

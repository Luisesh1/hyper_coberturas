const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normCdf,
  blackScholes,
  greeks,
  impliedVol,
  intrinsic,
} = require('../src/services/options/options-pricing');

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} ≉ ${b}`);

test('normCdf cumple valores de referencia y simetría', () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.9750021, 1e-6);
  close(normCdf(-1), 0.1586553, 1e-6);
  close(normCdf(2) + normCdf(-2), 1, 1e-9);
});

test('blackScholes reproduce el ejemplo de Hull (S=42 K=40 r=10% σ=20% T=0.5)', () => {
  close(blackScholes({ S: 42, K: 40, T: 0.5, iv: 0.2, r: 0.1, type: 'C' }), 4.76, 0.01);
  close(blackScholes({ S: 42, K: 40, T: 0.5, iv: 0.2, r: 0.1, type: 'P' }), 0.81, 0.01);
});

test('blackScholes respeta la paridad put-call con r=0', () => {
  const args = { S: 60000, K: 65000, T: 30 / 365, iv: 0.55 };
  const call = blackScholes({ ...args, type: 'C' });
  const put = blackScholes({ ...args, type: 'P' });
  close(call - put, args.S - args.K, 1e-6);
});

test('vencida o sin volatilidad devuelve el intrínseco', () => {
  assert.equal(blackScholes({ S: 100, K: 90, T: 0, iv: 0.5, type: 'C' }), 10);
  assert.equal(blackScholes({ S: 100, K: 90, T: 0, iv: 0.5, type: 'P' }), 0);
  assert.equal(intrinsic({ S: 80, K: 90, type: 'put' }), 10);
});

test('greeks: delta ATM ≈ 0.5, delta put = delta call − 1, gamma y vega positivas, theta negativa', () => {
  const args = { S: 100, K: 100, T: 0.25, iv: 0.6 };
  const c = greeks({ ...args, type: 'C' });
  const p = greeks({ ...args, type: 'P' });
  assert.ok(c.delta > 0.5 && c.delta < 0.6);
  close(p.delta, c.delta - 1, 1e-9);
  assert.ok(c.gamma > 0 && c.vega > 0);
  assert.ok(c.theta < 0 && p.theta < 0);
  // vega por punto de volatilidad: diferencia finita
  const bump = blackScholes({ ...args, iv: 0.61, type: 'C' }) - blackScholes({ ...args, type: 'C' });
  close(c.vega, bump, 0.01);
});

test('impliedVol recupera la volatilidad de entrada', () => {
  for (const iv of [0.2, 0.55, 1.2]) {
    for (const type of ['C', 'P']) {
      const price = blackScholes({ S: 3000, K: 3200, T: 14 / 365, iv, type });
      close(impliedVol({ price, S: 3000, K: 3200, T: 14 / 365, type }), iv, 1e-4, `${type} ${iv}`);
    }
  }
});

test('impliedVol devuelve null fuera de los límites de no arbitraje', () => {
  assert.equal(impliedVol({ price: 5, S: 100, K: 90, T: 0.1, type: 'C' }), null);
  assert.equal(impliedVol({ price: 0, S: 100, K: 90, T: 0.1, type: 'C' }), null);
  assert.throws(() => blackScholes({ S: 1, K: 1, T: 1, iv: 1, type: 'X' }), /Tipo de opción/);
});

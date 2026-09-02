const test = require('node:test');
const assert = require('node:assert/strict');

const httpClient = require('../src/shared/platform/http/http-client');
const HyperliquidService = require('../src/services/hyperliquid.service');

// Clave quemada de pruebas: nunca sale de este proceso, solo hace falta para
// que el servicio pueda firmar y llegar al POST que interceptamos.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function buildService() {
  return new HyperliquidService({ privateKey: TEST_KEY });
}

/**
 * Intercepta el POST y devuelve la respuesta que HL daria, registrando cada
 * intento con su nonce. Un rechazo aplicativo viaja como HTTP 200 con
 * `status: 'err'`, que es justo el caso que se clasificaba mal.
 */
function stubPost(responses) {
  const calls = [];
  const original = httpClient.post;
  httpClient.post = async (url, body) => {
    calls.push({ url, nonce: body?.nonce, action: body?.action?.type });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === 'function') return next(calls.length);
    return { data: next };
  };
  return { calls, restore: () => { httpClient.post = original; } };
}

test('un rechazo aplicativo de HL en ingles NO se reintenta', async () => {
  // ESTE es el bug. El guard filtraba por textos en espanol que arma este
  // servicio; el throw de `status:'err'` propaga el texto CRUDO de HL, en
  // ingles. No matcheaba nada, `err.response` es undefined por ser throw
  // propio, y se reintentaba con el MISMO nonce -> "duplicate nonce" siempre,
  // pisando la causa real.
  const { calls, restore } = stubPost([
    { status: 'err', response: 'Position does not have sufficient margin for reduction.' },
    { status: 'err', response: 'Invalid nonce: duplicate nonce 1788295047860' },
  ]);
  try {
    const service = buildService();
    await assert.rejects(
      () => service.updateIsolatedMargin(1, false, -11),
      // El error que sale es la causa REAL, no el nonce.
      (err) => {
        assert.match(err.message, /sufficient margin for reduction/);
        assert.doesNotMatch(err.message, /nonce/i);
        return true;
      },
    );
    assert.equal(calls.length, 1, 'un rechazo aplicativo se manda UNA sola vez');
  } finally {
    restore();
  }
});

test('un fallo de red si se reintenta, y con el MISMO nonce', async () => {
  // Reusar el nonce es deliberado: si el primer intento si llego a HL, el
  // reintento choca con "duplicate nonce" y no se ejecuta dos veces. Es el
  // mecanismo de deduplicacion, no un descuido — si alguien lo "arregla"
  // refirmando, convierte un timeout en una posible doble ejecucion.
  const { calls, restore } = stubPost([
    () => { throw new Error('socket hang up'); },
    { status: 'ok', response: { type: 'default' } },
  ]);
  try {
    const service = buildService();
    await service.updateIsolatedMargin(1, false, 5);
    assert.equal(calls.length, 2, 'el fallo de red si se reintenta');
    assert.equal(calls[0].nonce, calls[1].nonce, 'el reintento conserva el nonce');
  } finally {
    restore();
  }
});

test('un 5xx tambien se reintenta', async () => {
  const { calls, restore } = stubPost([
    () => {
      const err = new Error('bad gateway');
      err.response = { status: 502, headers: {}, data: {} };
      throw err;
    },
    { status: 'ok', response: { type: 'default' } },
  ]);
  try {
    await buildService().updateIsolatedMargin(1, false, 5);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test('acciones no idempotentes no se reintentan ni ante fallo de red', async () => {
  // `updateLeverage` es idempotente; una orden SIN cloid no lo es. Se prueba
  // con el helper interno para no depender de la firma publica de cada metodo.
  const service = buildService();
  const { calls, restore } = stubPost([
    () => { throw new Error('socket hang up'); },
    { status: 'ok', response: { type: 'default' } },
  ]);
  try {
    await assert.rejects(() => service._sendAction({
      type: 'order',
      orders: [{ a: 1, b: false, p: '100', s: '1', r: false }], // sin `c` (cloid)
      grouping: 'na',
    }));
    assert.equal(calls.length, 1, 'sin cloid no hay dedupe, asi que no se reintenta');
  } finally {
    restore();
  }
});

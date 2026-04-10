const test = require('node:test');
const assert = require('node:assert/strict');

// El sink lee `config.server.nodeEnv` en cada llamada, así que para
// testearlo basta con setear NODE_ENV antes del require.
const ORIGINAL_ENV = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

// Borra el cache de require para que el config se reevalúe.
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/services/dev-log-sink.service')];
const sink = require('../src/services/dev-log-sink.service');

test('dev-log-sink: isEnabled refleja NODE_ENV', () => {
  assert.equal(sink.isEnabled(), true);
});

test('dev-log-sink: publish agrega al buffer y emite evento', () => {
  sink.clear();
  let received = null;
  const off = sink.on('entry', (e) => { received = e; });
  const result = sink.publish({ level: 'error', message: 'boom', source: 'test' });
  assert.ok(result, 'publish debe devolver el entry enriquecido');
  assert.equal(result.message, 'boom');
  assert.equal(result.level, 'error');
  assert.equal(result.source, 'test');
  assert.ok(typeof result.id === 'number' && result.id > 0);
  assert.ok(received, 'el listener debe recibir el evento');
  assert.equal(received.id, result.id);
  off();
});

test('dev-log-sink: snapshot devuelve los últimos N entries', () => {
  sink.clear();
  for (let i = 0; i < 10; i += 1) {
    sink.publish({ level: 'warn', message: `m${i}`, source: 'test' });
  }
  const snap = sink.snapshot({ limit: 5 });
  assert.equal(snap.length, 5);
  assert.equal(snap[0].message, 'm5');
  assert.equal(snap[4].message, 'm9');
});

test('dev-log-sink: ring buffer descarta los más viejos', () => {
  sink.clear();
  for (let i = 0; i < sink.RING_CAPACITY + 50; i += 1) {
    sink.publish({ level: 'error', message: `m${i}`, source: 'test' });
  }
  const snap = sink.snapshot();
  assert.equal(snap.length, sink.RING_CAPACITY);
  assert.equal(snap[0].message, 'm50');
});

test('dev-log-sink: publishMany cuenta entries válidos', () => {
  sink.clear();
  const count = sink.publishMany([
    { level: 'error', message: 'a', source: 'client' },
    { level: 'warn', message: 'b', source: 'client' },
    { level: 'error', message: 'c', source: 'client' },
  ]);
  assert.equal(count, 3);
  assert.equal(sink.snapshot().length, 3);
});

test('dev-log-sink: en producción es no-op', () => {
  // Forzamos el reload con NODE_ENV=production
  process.env.NODE_ENV = 'production';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/dev-log-sink.service')];
  // El cargador de config valida prod y exige JWT_SECRET — lo seteamos
  // temporal sólo para que el require pase.
  const prevSecret = process.env.JWT_SECRET;
  const prevDb = process.env.DATABASE_URL;
  const prevEnc = process.env.SETTINGS_ENCRYPTION_KEY;
  const prevClient = process.env.CLIENT_URL;
  process.env.JWT_SECRET = 'a-secure-jwt-secret-for-tests-1234567890';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  process.env.SETTINGS_ENCRYPTION_KEY = 'a-secure-settings-encryption-key-9876';
  process.env.CLIENT_URL = 'http://localhost:5174';
  try {
    const prodSink = require('../src/services/dev-log-sink.service');
    assert.equal(prodSink.isEnabled(), false);
    assert.equal(prodSink.publish({ level: 'error', message: 'x' }), null);
    assert.deepEqual(prodSink.snapshot(), []);
  } finally {
    process.env.NODE_ENV = ORIGINAL_ENV;
    if (prevSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevSecret;
    if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
    if (prevEnc === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = prevEnc;
    if (prevClient === undefined) delete process.env.CLIENT_URL; else process.env.CLIENT_URL = prevClient;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/dev-log-sink.service')];
  }
});

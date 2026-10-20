const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOptionsAccountStream, eventName } = require('../src/services/options/options-account-stream.service');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// WebSocket falso: registra las URLs y deja emitir mensajes a mano.
function fakeWsFactory() {
  const sockets = [];
  class FakeWs extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.closed = false;
      sockets.push(this);
      setImmediate(() => this.emit('open'));
    }
    close() { this.closed = true; }
    push(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  }
  return { FakeWs, sockets };
}

function setup(overrides = {}) {
  const { FakeWs, sockets } = fakeWsFactory();
  const calls = { snapshot: 0, create: 0, close: 0 };
  let fail = null;
  const client = {
    async createListenKey() { calls.create += 1; return { listenKey: `key${calls.create}` }; },
    async keepAliveListenKey() {},
    async closeListenKey() { calls.close += 1; },
  };
  const stream = createOptionsAccountStream({
    getClient: async () => client,
    loadSnapshot: async () => {
      calls.snapshot += 1;
      if (fail) throw fail;
      return { account: { balanceUsdt: 100 + calls.snapshot }, positions: [], openOrders: [] };
    },
    WebSocketImpl: FakeWs,
    wsBaseUrl: 'wss://example.test/private',
    debounceMs: 5,
    periodicMinMs: 10_000,
    streamPollMs: 60_000,
    fallbackPollMs: 60_000,
    idleCloseMs: 10,
    ...overrides,
  });
  return { stream, sockets, calls, setFail: (e) => { fail = e; } };
}

test('eventName lee el evento con y sin sobre stream/data', () => {
  assert.equal(eventName({ e: 'ORDER_TRADE_UPDATE' }), 'ORDER_TRADE_UPDATE');
  assert.equal(eventName({ stream: 'x', data: { e: 'ACCOUNT_UPDATE' } }), 'ACCOUNT_UPDATE');
  assert.equal(eventName({ foo: 1 }), null);
});

test('un stream por usuario compartido por varias pestañas y relectura por evento', async () => {
  const { stream, sockets, calls } = setup();
  const a = []; const b = [];
  const unsubA = stream.subscribe(1, (p) => a.push(p));
  const unsubB = stream.subscribe(1, (p) => b.push(p));
  await tick(30);
  assert.equal(sockets.length, 1, 'un solo WebSocket para el usuario');
  assert.equal(sockets[0].url, 'wss://example.test/private/ws/key1');
  const afterOpen = calls.snapshot;
  assert.ok(a.length >= 1 && b.length >= 1);
  assert.equal(a.at(-1).live, true);

  // Una ráfaga de eventos de orden se agrupa en una sola relectura.
  sockets[0].push({ e: 'ORDER_TRADE_UPDATE' });
  sockets[0].push({ e: 'ORDER_TRADE_UPDATE' });
  await tick(30);
  assert.equal(calls.snapshot, afterOpen + 1);

  // Los eventos periódicos no releen si hubo una relectura reciente.
  sockets[0].push({ e: 'ACCOUNT_UPDATE' });
  await tick(30);
  assert.equal(calls.snapshot, afterOpen + 1);

  unsubA(); unsubB();
  await tick(30);
  assert.equal(sockets[0].closed, true);
  assert.equal(calls.close, 1, 'cierra el listenKey al quedarse sin suscriptores');
});

test('ante un 429 conserva el último snapshot marcado como stale', async () => {
  const { stream, sockets, setFail } = setup();
  const seen = [];
  const unsub = stream.subscribe(7, (p) => seen.push(p));
  await tick(30);
  const good = seen.at(-1).account.balanceUsdt;
  setFail(Object.assign(new Error('Binance Opciones: límite de peticiones, consulta aplazada'), { code: 'BINANCE_OPTIONS_RATE_LIMIT' }));
  sockets[0].push({ e: 'BALANCE_POSITION_UPDATE' });
  await tick(30);
  const last = seen.at(-1);
  assert.equal(last.stale, true);
  assert.equal(last.account.balanceUsdt, good);
  assert.equal(last.error.code, 'BINANCE_OPTIONS_RATE_LIMIT');
  assert.equal(stream.getLast(7).account.balanceUsdt, good);
  unsub();
  stream.shutdown();
});

test('listenKeyExpired reconecta con una key nueva', async () => {
  const { stream, sockets, calls } = setup({ reconnectBaseMs: 5 });
  const unsub = stream.subscribe(3, () => {});
  await tick(30);
  sockets[0].push({ e: 'listenKeyExpired' });
  await tick(40);
  assert.equal(calls.create, 2);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'wss://example.test/private/ws/key2');
  unsub();
  stream.shutdown();
});

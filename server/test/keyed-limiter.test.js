const { test } = require('node:test');
const assert = require('node:assert/strict');
const KeyedLimiter = require('../src/utils/keyed-limiter');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(setImmediate);

// Crea una tarea que registra su arranque y espera a un deferred.
function task(started, name) {
  const d = deferred();
  const fn = () => { started.push(name); return d.promise; };
  return { fn, d };
}

test('respeta maxConcurrent', async () => {
  const limiter = new KeyedLimiter({ maxConcurrent: 2 });
  const started = [];
  const a = task(started, 'a');
  const b = task(started, 'b');
  const c = task(started, 'c');
  const pa = limiter.run('a', a.fn);
  const pb = limiter.run('b', b.fn);
  const pc = limiter.run('c', c.fn);
  await flush();
  assert.deepEqual(started, ['a', 'b']);
  a.d.resolve(1);
  await pa;
  await flush();
  assert.deepEqual(started, ['a', 'b', 'c']);
  b.d.resolve(2);
  c.d.resolve(3);
  assert.deepEqual(await Promise.all([pb, pc]), [2, 3]);
});

test('serializa la misma clave', async () => {
  const limiter = new KeyedLimiter({ maxConcurrent: 3 });
  const started = [];
  const first = task(started, 'first');
  const second = task(started, 'second');
  const p1 = limiter.run('a', first.fn);
  const p2 = limiter.run('a', second.fn);
  await flush();
  assert.deepEqual(started, ['first']);
  first.d.resolve();
  await p1;
  await flush();
  assert.deepEqual(started, ['first', 'second']);
  second.d.resolve();
  await p2;
});

test('una clave ocupada no bloquea a otras', async () => {
  const limiter = new KeyedLimiter({ maxConcurrent: 2 });
  const started = [];
  const a1 = task(started, 'a1');
  const a2 = task(started, 'a2');
  const b = task(started, 'b');
  const p1 = limiter.run('a', a1.fn);
  const p2 = limiter.run('a', a2.fn);
  const p3 = limiter.run('b', b.fn);
  await flush();
  assert.deepEqual(started, ['a1', 'b']);
  a1.d.resolve();
  b.d.resolve();
  await flush();
  a2.d.resolve();
  await Promise.all([p1, p2, p3]);
});

test('propaga el rechazo y libera el hueco', async () => {
  const limiter = new KeyedLimiter({ maxConcurrent: 1 });
  const started = [];
  const a = task(started, 'a');
  const b = task(started, 'b');
  const pa = limiter.run('a', a.fn);
  const pb = limiter.run('b', b.fn);
  await flush();
  assert.deepEqual(started, ['a']);
  const err = new Error('boom');
  a.d.reject(err);
  await assert.rejects(pa, err);
  await flush();
  assert.deepEqual(started, ['a', 'b']);
  b.d.resolve();
  await pb;
  assert.equal(limiter.size, 0);
});

test('idle espera a que se vacíe', async () => {
  const limiter = new KeyedLimiter({ maxConcurrent: 1 });
  await limiter.idle();
  const started = [];
  const a = task(started, 'a');
  const b = task(started, 'b');
  const pa = limiter.run('a', a.fn);
  const pb = limiter.run('b', b.fn);
  assert.equal(limiter.size, 2);
  let idle = false;
  const pi = limiter.idle().then(() => { idle = true; });
  await flush();
  assert.equal(idle, false);
  a.d.resolve();
  await pa;
  await flush();
  assert.equal(idle, false);
  b.d.resolve();
  await pb;
  await pi;
  assert.equal(idle, true);
  assert.equal(limiter.size, 0);
});

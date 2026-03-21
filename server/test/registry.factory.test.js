const test = require('node:test');
const assert = require('node:assert/strict');

const { createRegistry } = require('../src/services/registry.factory');

test('createRegistry deduplica construcciones concurrentes de la misma clave', async () => {
  let buildCount = 0;
  const instance = { id: 'runtime-1' };

  const registry = createRegistry({
    name: 'TestRegistry',
    keyFn: (id) => String(id),
    async buildFn() {
      buildCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return instance;
    },
  });

  const [first, second, third] = await Promise.all([
    registry.getOrCreate(1),
    registry.getOrCreate(1),
    registry.getOrCreate(1),
  ]);

  assert.equal(buildCount, 1);
  assert.equal(first, instance);
  assert.equal(second, instance);
  assert.equal(third, instance);
});

test('createRegistry descarta una construccion vieja si hubo reload en vuelo', async () => {
  let buildCount = 0;
  let destroyCount = 0;

  const registry = createRegistry({
    name: 'TestRegistry',
    keyFn: (id) => String(id),
    async buildFn(id) {
      buildCount += 1;
      const currentBuild = buildCount;
      await new Promise((resolve) => setTimeout(resolve, currentBuild === 1 ? 20 : 5));
      return { id: `${id}-${currentBuild}` };
    },
    destroyFn() {
      destroyCount += 1;
    },
  });

  const firstPromise = registry.getOrCreate(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reloaded = await registry.reload(1);
  const firstResolved = await firstPromise;

  assert.equal(buildCount, 2);
  assert.equal(reloaded.id, '1-2');
  assert.equal(firstResolved, reloaded);
  assert.equal(registry.get(1), reloaded);
  assert.equal(destroyCount, 1);
});

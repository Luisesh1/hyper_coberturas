const test = require('node:test');
const assert = require('node:assert/strict');

const { selectProtectedPoolIdsToDelete } = require('../src/services/protected-pool-maintenance.service');

test('selectProtectedPoolIdsToDelete conserva el activo mas reciente dentro de un grupo duplicado', () => {
  const result = selectProtectedPoolIdsToDelete([
    { id: 10, status: 'inactive', updatedAt: 100 },
    { id: 11, status: 'active', updatedAt: 200 },
    { id: 12, status: 'active', updatedAt: 150 },
  ]);

  assert.deepEqual(result.sort((a, b) => a - b), [10, 12]);
});

test('selectProtectedPoolIdsToDelete elimina todos los duplicados si ninguno esta activo', () => {
  const result = selectProtectedPoolIdsToDelete([
    { id: 21, status: 'inactive', updatedAt: 100 },
    { id: 22, status: 'inactive', updatedAt: 300 },
  ]);

  assert.deepEqual(result.sort((a, b) => a - b), [21, 22]);
});

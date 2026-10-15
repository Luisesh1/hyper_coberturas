const test = require('node:test');
const assert = require('node:assert/strict');

const { SUPPORTED_NETWORKS } = require('../src/services/uniswap/networks');
const { getUniversalRouterAddress } = require('../src/services/uniswap-v4-helpers.service');

// Toda acción v4 que pasa por el Universal Router (modificar rango, swaps del
// plan) falla con «No hay Universal Router configurado» si la red con v4 no
// tiene router. Pasó en Base (orquestador #64, LP #3110339).
test('cada red con despliegue v4 tiene Universal Router', () => {
  const v4Networks = Object.values(SUPPORTED_NETWORKS).filter((n) => n.deployments?.v4);
  assert.ok(v4Networks.length > 0);
  for (const network of v4Networks) {
    const router = getUniversalRouterAddress(network.id);
    assert.match(router || '', /^0x[0-9a-fA-F]{40}$/, `falta Universal Router para ${network.id}`);
  }
});

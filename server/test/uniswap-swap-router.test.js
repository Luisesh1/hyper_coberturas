const test = require('node:test');
const assert = require('node:assert/strict');

const { getV3SwapRouterAddress } = require('../src/services/uniswap/constants');
const { getNetworkConfig, SUPPORTED_NETWORKS } = require('../src/services/uniswap/networks');

// SwapRouter02 no vive en la misma direccion en todas las redes. En Base,
// 0x68b3...Fc45 es otro contrato cuyo fallback acepta la llamada sin hacer
// nada: los "swaps" se minaban en verde sin mover un token, y el mint caia
// despues con TRANSFER_FROM_FAILED por falta de USDC.
test('Base usa su propio SwapRouter02', () => {
  assert.equal(
    getV3SwapRouterAddress(getNetworkConfig('base')).toLowerCase(),
    '0x2626664c2603336e57b271c5c0b26f421741e481'
  );
});

test('toda red con v3 declara su swapRouter explicitamente', () => {
  for (const network of Object.values(SUPPORTED_NETWORKS)) {
    if (!network.deployments?.v3) continue;
    assert.match(
      String(network.deployments.v3.swapRouter || ''),
      /^0x[0-9a-fA-F]{40}$/,
      `${network.id} no declara deployments.v3.swapRouter`
    );
  }
});

test('sin swapRouter configurado falla en vez de usar una direccion de otra red', () => {
  assert.throws(
    () => getV3SwapRouterAddress({ id: 'nueva', deployments: { v3: {} } }),
    /swapRouter/
  );
});

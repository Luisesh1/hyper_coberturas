const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const onChainManager = require('../src/services/onchain-manager.service');
const { resolveBestDirectRoute } = require('../src/services/smart-pool-creator.service');

// Caso real: la wallet 0x28be...EE95 con 890 USDC en Arbitrum reventaba con
// "Too little received" al ejecutar el plan de fondeo. El selector de ruta
// ordenaba los fee tiers por el precio spot de slot0, que es practicamente
// identico entre tiers, asi que siempre ganaba el fee mas bajo — el pool 0.01%
// de USDC/WETH, con ~2700x menos liquidez que el de 0.05%. La salida real
// quedaba 125 bps por debajo de la estimada y el minimo (50 bps) no se
// cumplia. Cotizar con QuoterV2 hace que gane el pool con profundidad.

const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const USDC = { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 };
const WETH = { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 };
const AMOUNT_IN = ethers.parseUnits('890', 6);

const POOL_BY_FEE = {
  100: '0x6f38e884725a116C9C7fBF208e79FE8828a2595F',
  500: '0xC6962004f452bE9203591991D15f6b388e09E8D0',
  3000: '0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c',
  10000: '0x42FC852A750BA93D5bf772ecdc857e87a86403a9',
};

// Salidas medidas on-chain para 890 USDC -> WETH. El tier 100 es el peor pese
// a ser el de menor fee: no tiene liquidez para ese tamano.
const REAL_OUT_BY_FEE = {
  100: ethers.parseUnits('0.461365749313466205', 18),
  500: ethers.parseUnits('0.467065000376926629', 18),
  3000: ethers.parseUnits('0.466890863049169134', 18),
  10000: ethers.parseUnits('0.459500526154140176', 18),
};

function buildNetworkConfig({ withQuoter = true } = {}) {
  return {
    id: 'arbitrum',
    chainId: 42161,
    deployments: { v3: { eventSource: FACTORY, ...(withQuoter ? { quoter: QUOTER } : {}) } },
  };
}

/**
 * Sustituye onChainManager.getContract por dobles de factory / quoter / pool.
 * `quoteFn` recibe el fee y devuelve el amountOut (o lanza para simular un
 * tier que revierte).
 */
function stubContracts({ quoteFn, poolTick = -200_500 }) {
  const original = onChainManager.getContract;
  onChainManager.getContract = ({ address }) => {
    const addr = String(address).toLowerCase();
    if (addr === FACTORY.toLowerCase()) {
      return { getPool: async (_a, _b, fee) => POOL_BY_FEE[Number(fee)] || ethers.ZeroAddress };
    }
    if (addr === QUOTER.toLowerCase()) {
      return {
        quoteExactInputSingle: {
          staticCall: async (params) => [await quoteFn(Number(params.fee)), 0n, 0, 0n],
        },
      };
    }
    return {
      slot0: async () => ({ tick: poolTick }),
      token0: async () => WETH.address,
      token1: async () => USDC.address,
    };
  };
  return () => { onChainManager.getContract = original; };
}

test('elige el fee tier por la cotizacion real, no por el fee mas bajo', async () => {
  const restore = stubContracts({ quoteFn: async (fee) => REAL_OUT_BY_FEE[fee] });
  try {
    const route = await resolveBestDirectRoute({
      provider: {},
      networkConfig: buildNetworkConfig(),
      tokenIn: USDC,
      tokenOut: WETH,
      amountInRaw: AMOUNT_IN,
    });
    assert.equal(route.fee, 500);
    assert.equal(route.quoteSource, 'quoter');
    // El esperado es exactamente lo cotizado: sin margen de modelo que tapar,
    // los 50 bps de slippage quedan integros para el movimiento de precio.
    assert.equal(route.expectedOutRaw, REAL_OUT_BY_FEE[500]);
    assert.equal(route.poolAddress, ethers.getAddress(POOL_BY_FEE[500]));
  } finally {
    restore();
  }
});

test('un tier que revierte al cotizar no tumba la ruta', async () => {
  const restore = stubContracts({
    quoteFn: async (fee) => {
      if (fee === 500) throw new Error('execution reverted');
      return REAL_OUT_BY_FEE[fee];
    },
  });
  try {
    const route = await resolveBestDirectRoute({
      provider: {},
      networkConfig: buildNetworkConfig(),
      tokenIn: USDC,
      tokenOut: WETH,
      amountInRaw: AMOUNT_IN,
    });
    // Descartado el 500, el mejor de los que si cotizan es el 3000.
    assert.equal(route.fee, 3000);
    assert.equal(route.expectedOutRaw, REAL_OUT_BY_FEE[3000]);
  } finally {
    restore();
  }
});

test('sin quoter en la red cae al precio spot y lo marca en quoteSource', async () => {
  const restore = stubContracts({ quoteFn: async () => { throw new Error('no deberia cotizar'); } });
  try {
    const route = await resolveBestDirectRoute({
      provider: {},
      networkConfig: buildNetworkConfig({ withQuoter: false }),
      tokenIn: USDC,
      tokenOut: WETH,
      amountInRaw: AMOUNT_IN,
    });
    assert.equal(route.quoteSource, 'spot');
    // Todos los tiers comparten el mismo slot0 en el stub, asi que con el
    // estimador spot gana el fee mas bajo: exactamente el sesgo que el quoter
    // corrige cuando ese pool no tiene liquidez.
    assert.equal(route.fee, 100);
    assert.ok(route.expectedOutRaw > 0n);
  } finally {
    restore();
  }
});

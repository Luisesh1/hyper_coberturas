const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const onChainManager = require('../src/services/onchain-manager.service');
const smartPoolCreatorService = require('../src/services/smart-pool-creator.service');

const {
  PLAN_GAS_UNITS_BUDGET,
  computeGasReserveRaw,
  assertNativeCoversGas,
} = require('../src/services/uniswap/gas-reserve');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

/**
 * Corre `getWalletAssets` contra un provider falso con el gas price dado.
 * Sirve para verificar el CABLEADO: que la reserva dinámica efectivamente
 * llegue desde `computeGasReserveRaw` hasta el `gasReserve` que consume el
 * planner, no solo que la función pura calcule bien.
 */
async function walletAssetsWithGasPrice(gasPriceWei) {
  const originalGetProvider = onChainManager.getProvider;
  const originalAggregate = onChainManager.aggregate;
  onChainManager.getProvider = () => ({
    getFeeData: async () => (gasPriceWei == null
      ? (() => { throw new Error('rpc caido'); })()
      : { gasPrice: gasPriceWei, maxFeePerGas: null }),
    getBalance: async () => eth('1'),
  });
  // Balance nativo de 1 ETH y 0 en cada ERC20.
  onChainManager.aggregate = async ({ calls }) => calls.map((_, idx) => ({
    success: true,
    value: idx === 0 ? eth('1').toString() : '0',
  }));
  try {
    return await smartPoolCreatorService.getWalletAssets({
      network: 'ethereum',
      walletAddress: WALLET,
    });
  } finally {
    onChainManager.getProvider = originalGetProvider;
    onChainManager.aggregate = originalAggregate;
  }
}

const gwei = (n) => BigInt(Math.round(n * 1e9));
const eth = (n) => ethers.parseUnits(String(n), 18);

test('el presupuesto de gas del plan cubre la creacion mas cara (mint v4 + swap + wrap + unwrap + approvals)', () => {
  // 420k mint v4 + 200k swap + 90k wrap + 90k unwrap + 50k approval + 65k permit2
  assert.equal(PLAN_GAS_UNITS_BUDGET, 915_000);
});

test('en L2 la reserva dinamica no baja del piso estatico (sin regresion)', () => {
  // Base a 0.02 gwei: el plan cuesta ~0.00002 ETH, muy por debajo del piso.
  const reserve = computeGasReserveRaw({ network: 'base', gasPriceWei: gwei(0.02) });
  assert.equal(reserve, eth('0.0015'));

  // Arbitrum a 0.1 gwei: idem.
  const arb = computeGasReserveRaw({ network: 'arbitrum', gasPriceWei: gwei(0.1) });
  assert.equal(arb, eth('0.002'));
});

test('en Ethereum con gas barato tambien gana el piso estatico', () => {
  const reserve = computeGasReserveRaw({ network: 'ethereum', gasPriceWei: gwei(5) });
  assert.equal(reserve, eth('0.01'));
});

test('en Ethereum con gas caro la reserva escala por encima del piso estatico', () => {
  const reserve = computeGasReserveRaw({ network: 'ethereum', gasPriceWei: gwei(30) });
  // 915_000 * 1.2 * 30 gwei = 0.03294 ETH
  assert.equal(reserve, eth('0.03294'));
  assert.ok(reserve > eth('0.01'), 'debe superar el piso estatico de Ethereum');
});

test('sin feeData del provider cae al piso estatico en vez de romper', () => {
  assert.equal(computeGasReserveRaw({ network: 'ethereum', gasPriceWei: null }), eth('0.01'));
  assert.equal(computeGasReserveRaw({ network: 'ethereum', gasPriceWei: 0n }), eth('0.01'));
  assert.equal(computeGasReserveRaw({ network: 'ethereum' }), eth('0.01'));
});

test('una red desconocida usa el default de 0.002', () => {
  assert.equal(computeGasReserveRaw({ network: 'red-inventada', gasPriceWei: 0n }), eth('0.002'));
});

test('assertNativeCoversGas pasa cuando lo que queda alcanza para el gas', () => {
  assert.doesNotThrow(() => assertNativeCoversGas({
    network: 'ethereum',
    nativeSymbol: 'ETH',
    nativeBalanceRaw: eth('0.05'),
    nativeUsedForFundingRaw: eth('0.01'),
    gasReserveRaw: eth('0.03294'),
  }));
});

test('assertNativeCoversGas rechaza cuando el nativo no cubre el gas del plan', () => {
  // Caso del footgun: el usuario fondea con USDC (no toca su ETH) pero su ETH
  // no alcanza para las 4 txs. Hoy se entera despues de firmar el swap.
  assert.throws(
    () => assertNativeCoversGas({
      network: 'ethereum',
      nativeSymbol: 'ETH',
      nativeBalanceRaw: eth('0.008'),
      nativeUsedForFundingRaw: 0n,
      gasReserveRaw: eth('0.03294'),
    }),
    (err) => {
      assert.equal(err.code, 'INSUFFICIENT_NATIVE_FOR_GAS');
      assert.match(err.message, /ETH/);
      return true;
    }
  );
});

test('cableado: getWalletAssets aplica la reserva dinamica con gas caro', async () => {
  const result = await walletAssetsWithGasPrice(gwei(30));
  assert.equal(result.gasReserve.reservedRaw, eth('0.03294').toString());
  // `reservedAmount` es el texto que sale en los mensajes de error: tiene que
  // reflejar la reserva real, no el piso de la tabla.
  assert.equal(result.gasReserve.reservedAmount, '0.03294');
  // Y lo usable baja en consecuencia: 1 ETH - 0.03294.
  assert.equal(result.gasReserve.usableNativeRaw, (eth('1') - eth('0.03294')).toString());
});

test('cableado: con gas barato getWalletAssets mantiene el piso estatico', async () => {
  const result = await walletAssetsWithGasPrice(gwei(5));
  assert.equal(result.gasReserve.reservedRaw, eth('0.01').toString());
});

test('cableado: si el RPC no da feeData se usa el piso y no revienta', async () => {
  const result = await walletAssetsWithGasPrice(null);
  assert.equal(result.gasReserve.reservedRaw, eth('0.01').toString());
});

test('assertNativeCoversGas cuenta el nativo que se va al fondeo', () => {
  // Balance alcanzaria, pero el fondeo se lleva casi todo.
  assert.throws(
    () => assertNativeCoversGas({
      network: 'ethereum',
      nativeSymbol: 'ETH',
      nativeBalanceRaw: eth('0.04'),
      nativeUsedForFundingRaw: eth('0.02'),
      gasReserveRaw: eth('0.03294'),
    }),
    (err) => err.code === 'INSUFFICIENT_NATIVE_FOR_GAS'
  );
});

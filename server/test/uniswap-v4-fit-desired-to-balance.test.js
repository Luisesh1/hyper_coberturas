const test = require('node:test');
const assert = require('node:assert/strict');

const onChainManager = require('../src/services/onchain-manager.service');
const { fitDesiredAmountsToBalance, applyMintSlippageCeiling } = require('../src/services/uniswap/actions/prepare-v4');

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 };
const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 };
const NATIVE = { address: ZERO, symbol: 'ETH', decimals: 18 };
const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const NETWORK = { id: 'arbitrum', chainId: 42161, label: 'Arbitrum' };

/**
 * `getBalancesAndAllowancesBatch` lee la cadena via onChainManager.aggregate.
 * Se sustituye para fijar el saldo de cada token.
 */
function stubBalances(byAddress) {
  const original = onChainManager.aggregate;
  onChainManager.aggregate = async ({ calls }) => calls.map((call) => ({
    success: true,
    value: (byAddress[String(call.target).toLowerCase()] ?? 0n).toString(),
  }));
  return () => { onChainManager.aggregate = original; };
}

async function fit(args, balances) {
  const restore = stubBalances(balances);
  try {
    return await fitDesiredAmountsToBalance({
      provider: {},
      networkConfig: NETWORK,
      walletAddress: WALLET,
      slippageBps: 50,
      ...args,
    });
  } finally {
    restore();
  }
}

// Regresion del caso real que reventaba con TRANSFER_FROM_FAILED al crear un
// orquestador: el plan asignaba los 50.496248 USDC enteros de la wallet, y el
// techo del mint (+0.5% = 50.748729) quedaba 0.25 USDC POR ENCIMA del saldo.
// El PositionManager tira del techo via Permit2, asi que el transferFrom
// pedia mas de lo que existia.
test('aportar el saldo entero de un token deja sitio para el techo', async () => {
  const saldo = 50_496248n;
  const { amount1 } = await fit(
    { token0: NATIVE, token1: USDC, amount0Desired: 10n ** 16n, amount1Desired: saldo },
    { [USDC.address.toLowerCase()]: saldo }
  );

  assert.ok(amount1 < saldo, 'el aporte se recorta para dejar margen');
  assert.ok(
    applyMintSlippageCeiling(amount1, 50) <= saldo,
    `el techo ${applyMintSlippageCeiling(amount1, 50)} debe caber en ${saldo}`
  );
  // El recorte es el minimo necesario: ~0.5%, no una rebaja arbitraria.
  assert.ok(amount1 > (saldo * 99n) / 100n, 'no se recorta mas de lo imprescindible');
});

test('si el techo ya cabe no se toca nada', async () => {
  const deseado = 40_000000n;
  const { amount1 } = await fit(
    { token0: NATIVE, token1: USDC, amount0Desired: 0n, amount1Desired: deseado },
    { [USDC.address.toLowerCase()]: 100_000000n }
  );
  assert.equal(amount1, deseado);
});

// Pedir mas de lo que hay no es falta de margen: es falta de fondos, y tiene
// que morir en el chequeo de balance con un mensaje claro, no recortarse en
// silencio hasta lo que quepa.
test('un aporte que no cabe en el saldo no se recorta', async () => {
  const deseado = 200_000000n;
  const { amount1 } = await fit(
    { token0: NATIVE, token1: USDC, amount0Desired: 0n, amount1Desired: deseado },
    { [USDC.address.toLowerCase()]: 50_000000n }
  );
  assert.equal(amount1, deseado, 'se deja pasar para que lo rechace el chequeo de balance');
});

test('el lado nativo no se toca: se paga con el value, no con transferFrom', async () => {
  const deseado = 10n ** 18n;
  const { amount0 } = await fit(
    { token0: NATIVE, token1: USDC, amount0Desired: deseado, amount1Desired: 0n },
    { [ZERO]: 0n }
  );
  assert.equal(amount0, deseado);
});

test('recorta los dos lados cuando ambos son ERC-20 al limite', async () => {
  const saldo0 = 1_000000000000000000n;
  const saldo1 = 50_000000n;
  const { amount0, amount1 } = await fit(
    { token0: WETH, token1: USDC, amount0Desired: saldo0, amount1Desired: saldo1 },
    { [WETH.address.toLowerCase()]: saldo0, [USDC.address.toLowerCase()]: saldo1 }
  );
  assert.ok(applyMintSlippageCeiling(amount0, 50) <= saldo0);
  assert.ok(applyMintSlippageCeiling(amount1, 50) <= saldo1);
});

// El fondeo inteligente puede traer parte del token de un swap del MISMO plan:
// el saldo de ahora no es el tope real. Recortar contra el saldo suelto
// mutilaria el aporte de quien va a recibir el token en la tx anterior.
test('cuenta lo que los swaps del plan van a entregar', async () => {
  const deseado = 100_000000n;
  const { amount1 } = await fit(
    {
      token0: NATIVE,
      token1: USDC,
      amount0Desired: 0n,
      amount1Desired: deseado,
      swapPlan: [{
        tokenIn: { address: WETH.address },
        tokenOut: { address: USDC.address },
        amountInRaw: '30000000000000000',
        amountOutMinimumRaw: '60000000',
      }],
    },
    { [USDC.address.toLowerCase()]: 45_000000n }
  );
  // 45 en la wallet + 60 que entrega el swap = 105 > techo de 100 (100.5).
  assert.equal(amount1, deseado, 'con el swap contado, el techo cabe');
});

test('descuenta lo que los swaps gastan de ese mismo token', async () => {
  const saldo = 50_000000n;
  const { amount1 } = await fit(
    {
      token0: NATIVE,
      token1: USDC,
      amount0Desired: 0n,
      amount1Desired: 30_000000n,
      swapPlan: [{
        tokenIn: { address: USDC.address },
        tokenOut: { address: WETH.address },
        amountInRaw: '20000000',
        amountOutMinimumRaw: '9000000000000000',
      }],
    },
    { [USDC.address.toLowerCase()]: saldo }
  );
  // 50 - 20 que gasta el swap = 30 disponibles para un deseado de 30: el techo
  // (30.15) no cabe, asi que se recorta.
  assert.ok(amount1 < 30_000000n);
  assert.ok(applyMintSlippageCeiling(amount1, 50) <= 30_000000n);
});

test('un saldo ilegible no recorta nada', async () => {
  const restore = (() => {
    const original = onChainManager.aggregate;
    onChainManager.aggregate = async ({ calls }) => calls.map(() => ({ success: false }));
    return () => { onChainManager.aggregate = original; };
  })();
  try {
    const result = await fitDesiredAmountsToBalance({
      provider: {},
      networkConfig: NETWORK,
      walletAddress: WALLET,
      token0: NATIVE,
      token1: USDC,
      amount0Desired: 0n,
      amount1Desired: 50_000000n,
      slippageBps: 50,
    });
    // Sin dato fiable no se inventa un recorte: lo para el chequeo de balance.
    assert.equal(result.amount1, 50_000000n);
  } finally {
    restore();
  }
});

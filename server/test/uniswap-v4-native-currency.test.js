const test = require('node:test');
const assert = require('node:assert/strict');

const { buildV4MintActions } = require('../src/services/uniswap/actions/prepare-v4');

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const OWNER = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

function mint(currency0, currency1) {
  return buildV4MintActions({
    poolKey: { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: ZERO },
    tickLower: -60,
    tickUpper: 60,
    liquidity: 1_000_000n,
    amount0Max: 111n,
    amount1Max: 222n,
    owner: OWNER,
  });
}

// Un pool ETH/USDC de Arbitrum llegaba al wizard, se fondeaba a medias y el
// mint salia con value 0: el PositionManager no recibia el lado nativo. La
// rama de smart funding — la unica que usa el wizard — no tenia nada de esto.
test('el lado nativo se paga con el value de la tx', () => {
  assert.equal(mint(ZERO, USDC).value, 111n, 'currency0 nativa paga amount0Max');
  assert.equal(mint(USDC, ZERO).value, 222n, 'currency1 nativa paga amount1Max');
});

test('un pool sin nativo no manda value', () => {
  assert.equal(mint(WETH, USDC).value, 0n);
});

// Sin SWEEP el sobrante del `value` queda atrapado en el PositionManager: se
// manda el techo con slippage, no el monto exacto.
test('el pool nativo agrega SWEEP para recuperar el sobrante', () => {
  const conNativo = mint(ZERO, USDC);
  assert.deepEqual(conNativo.v4Actions, ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'SWEEP']);
  assert.equal(conNativo.actionCodes.length, 4);
  assert.equal(conNativo.params.length, conNativo.actionCodes.length, 'cada accion necesita su param');
});

test('un pool sin nativo no agrega SWEEP', () => {
  const sinNativo = mint(WETH, USDC);
  assert.deepEqual(sinNativo.v4Actions, ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY']);
  assert.equal(sinNativo.params.length, sinNativo.actionCodes.length);
});

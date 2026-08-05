const test = require('node:test');
const assert = require('node:assert/strict');

const onChainManager = require('../src/services/onchain-manager.service');
const { appendPermit2Approvals } = require('../src/services/uniswap/actions/helpers');
const { PERMIT2_ADDRESS } = require('../src/services/uniswap-v4-helpers.service');
const { buildModifyRangeRedeployPlan } = require('../src/domains/uniswap/pools/domain/position-action-math');

const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 };
const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 };
const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const POSITION_MANAGER = '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869';

/**
 * `getPermit2State` lee la cadena via onChainManager.getContract. Se sustituye
 * por contratos de mentira para fijar el saldo que ve el planificador.
 */
function stubChain({ balance, tokenAllowance = 0n, permit2Allowance = 0n }) {
  const original = onChainManager.getContract;
  onChainManager.getContract = ({ address }) => {
    if (String(address).toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
      return { allowance: async () => [permit2Allowance, 0n, 0n] };
    }
    return {
      balanceOf: async () => balance,
      allowance: async () => tokenAllowance,
    };
  };
  return () => { onChainManager.getContract = original; };
}

async function planApprovals(args, chain) {
  const restore = stubChain(chain);
  const requiresApproval = [];
  const txPlan = [];
  try {
    await appendPermit2Approvals({
      provider: {},
      walletAddress: WALLET,
      spender: POSITION_MANAGER,
      chainId: 42161,
      requiresApproval,
      txPlan,
      ...args,
    });
  } finally {
    restore();
  }
  return { requiresApproval, txPlan };
}

// Regresion de un fallo real: ajustar el rango de un LP v4 respondia
// "La wallet no tiene balance suficiente de USDC" aunque el USDC estuviera
// intacto — dentro de la posicion. El chequeo miraba el saldo suelto de la
// wallet en tiempo de planificacion, cuando el DECREASE_LIQUIDITY que devuelve
// ese capital es la PRIMERA tx del mismo plan y todavia no se ejecuto.
test('el capital que libera una tx previa del plan cuenta como disponible', async () => {
  const { requiresApproval } = await planApprovals(
    { token: USDC, amount: 1_000_000000n, pendingCreditRaw: 1_000_000000n },
    { balance: 0n }
  );
  assert.equal(requiresApproval.length, 2, 'aprueba token->Permit2 y Permit2->spender');
});

test('sin credito del plan se sigue exigiendo saldo real en la wallet', async () => {
  // Agregar liquidez SI gasta fondos propios: ahi el chequeo debe morder.
  await assert.rejects(
    () => planApprovals({ token: USDC, amount: 1_000_000000n }, { balance: 999_000000n }),
    /balance suficiente de USDC/
  );
});

test('el credito no tapa un plan incoherente: si no alcanza, falla igual', async () => {
  // El plan promete 400 USDC y el mint quiere gastar 1000: eso es un bug de
  // planificacion, no un problema de saldo, y debe detenerse antes de firmar.
  await assert.rejects(
    () => planApprovals(
      { token: USDC, amount: 1_000_000000n, pendingCreditRaw: 400_000000n },
      { balance: 0n }
    ),
    /balance suficiente de USDC/
  );
});

test('la wallet y el plan se suman para cubrir el requisito', async () => {
  const { requiresApproval } = await planApprovals(
    { token: USDC, amount: 1_000_000000n, pendingCreditRaw: 400_000000n },
    { balance: 600_000000n }
  );
  assert.equal(requiresApproval.length, 2);
});

// El techo con slippage (applyMintSlippageCeiling) es cupo de allowance, no
// gasto: lo que el mint no consuma vuelve por CLOSE_CURRENCY/SWEEP. Exigirlo
// como saldo rechazaba a quien aporta exactamente todo su balance.
test('se exige el monto pedido, no el techo con slippage', async () => {
  const deseado = 1_000_000000n;
  const techo = deseado + (deseado / 100n); // +1%
  const { requiresApproval, txPlan } = await planApprovals(
    { token: USDC, amount: techo, balanceRequirementRaw: deseado },
    { balance: deseado }
  );
  assert.equal(requiresApproval.length, 2);
  assert.ok(
    requiresApproval.every((r) => BigInt(r.amount ?? r.amountRaw ?? techo) >= deseado),
    'la allowance sigue pidiendose por el techo, no por el monto justo'
  );
  assert.equal(txPlan.filter(Boolean).length, 2);
});

test('el error dice cuanto falta y de donde sale cada parte', async () => {
  await assert.rejects(
    () => planApprovals(
      { token: USDC, amount: 1_000_000000n, pendingCreditRaw: 250_000000n },
      { balance: 100_000000n }
    ),
    (err) => {
      assert.match(err.message, /se necesitan 1000\.0/);
      assert.match(err.message, /dispone de 350\.0/);
      assert.match(err.message, /100\.0 en la wallet/);
      assert.match(err.message, /250\.0 que liberan las txs previas/);
      return true;
    }
  );
});

test('un monto en cero no consulta saldo ni aprueba nada', async () => {
  const { requiresApproval, txPlan } = await planApprovals(
    { token: USDC, amount: 0n },
    { balance: 0n }
  );
  assert.equal(requiresApproval.length, 0);
  assert.equal(txPlan.length, 0);
});

// Premisa de la que depende el fix en prepareModifyRangeV4/prepareRebalanceV4:
// `amount{0,1}Desired` es exactamente lo que el plan deja en la wallet tras el
// decrease y el swap, asi que sirve de credito. Si el planificador dejara de
// descontar el amountIn, el credito quedaria inflado y el chequeo, ciego.
test('el redeploy planeado equivale al saldo proyectado tras decrease + swap', () => {
  const ctx = {
    priceCurrent: 2000,
    token0: { ...WETH },
    token1: { ...USDC },
  };
  const amount0Available = 1_000000000000000000n; // 1 WETH
  const amount1Available = 2000_000000n;          // 2000 USDC

  const plan = buildModifyRangeRedeployPlan(ctx, {
    amount0Available,
    amount1Available,
    lowerPrice: 1500,
    upperPrice: 2500,
    slippageBps: 100,
  });

  assert.ok(plan.swap, 'con pesos desbalanceados debe haber swap');
  const gastaToken0 = plan.swap.direction === 'token0_to_token1';
  const proyectado0 = gastaToken0
    ? amount0Available - plan.swap.amountIn
    : amount0Available + plan.swap.amountOutMinimum;
  const proyectado1 = gastaToken0
    ? amount1Available + plan.swap.amountOutMinimum
    : amount1Available - plan.swap.amountIn;

  assert.equal(plan.amount0Desired, proyectado0);
  assert.equal(plan.amount1Desired, proyectado1);
});

test('sin swap el redeploy es todo lo que libera el decrease', () => {
  const ctx = { priceCurrent: 2000, token0: { ...WETH }, token1: { ...USDC } };
  const plan = buildModifyRangeRedeployPlan(ctx, {
    amount0Available: 0n,
    amount1Available: 0n,
    lowerPrice: 1500,
    upperPrice: 2500,
    slippageBps: 100,
  });
  assert.equal(plan.swap, null);
  assert.equal(plan.amount0Desired, 0n);
  assert.equal(plan.amount1Desired, 0n);
});

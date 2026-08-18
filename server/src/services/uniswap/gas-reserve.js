/**
 * Reserva de gas del planner de fondeo.
 *
 * Vive aparte de `smart-pool-creator.service` porque es una unidad cerrada
 * (cuánto ETH hay que dejar sin gastar, y si lo que queda alcanza) y porque ese
 * servicio ya está en el trinquete de tamaño de `scripts/hotspot-baseline.json`.
 */

const { ethers } = require('ethers');
const logger = require('../logger.service');
const { AppError } = require('../../errors/app-error');
const { GAS_PER_TX_TYPE } = require('./gas-cost-estimator');

// Piso de reserva por red. Es un piso, no el valor final: la reserva efectiva
// la calcula `computeGasReserveRaw` combinándolo con el gas price vigente.
const GAS_RESERVE_BY_NETWORK = {
  ethereum: '0.01',
  arbitrum: '0.002',
  base: '0.0015',
  optimism: '0.0015',
  polygon: '1',
  'base-sepolia': '0.0015',
};

// Gas units del plan de creación más caro que el prepare puede emitir: mint v4
// + un swap + wrap + unwrap + approval ERC20 + approval Permit2. Se deriva de
// la tabla del estimador para que no se desincronice si esos costos cambian.
const PLAN_GAS_UNITS_BUDGET = GAS_PER_TX_TYPE.mint_position_v4
  + GAS_PER_TX_TYPE.swap
  + GAS_PER_TX_TYPE.wrap_native
  + GAS_PER_TX_TYPE.unwrap_native
  + GAS_PER_TX_TYPE.approval
  + GAS_PER_TX_TYPE.permit2_approval;

// Margen sobre el gas price actual: entre que se arma el plan y se firma la
// última tx pueden pasar minutos, y el precio se mueve. 20% sobre una tabla de
// gas units que ya es conservadora.
const GAS_RESERVE_SAFETY_NUMERATOR = 12n;
const GAS_RESERVE_SAFETY_DENOMINATOR = 10n;

function getGasReserveAmount(network) {
  return GAS_RESERVE_BY_NETWORK[String(network || '').toLowerCase()] || '0.002';
}

/**
 * Reserva de gas efectiva: el máximo entre el piso estático de la red y lo que
 * el plan realmente va a costar al gas price vigente.
 *
 * El piso solo era suficiente mientras el gas fuera barato. En Ethereum el plan
 * completo (915k gas units) supera los 0.01 ETH del piso a partir de ~9 gwei,
 * así que por encima de eso el planner dejaba al usuario con menos ETH del que
 * las propias txs del plan iban a consumir: el fondeo entraba, se firmaba el
 * swap, y el mint —la tx más cara y la última— se quedaba sin gas.
 *
 * En L2 el término dinámico queda dos órdenes de magnitud por debajo del piso,
 * así que allí el comportamiento no cambia.
 *
 * @param {{ network: string, gasPriceWei?: bigint|null }} args
 * @returns {bigint} reserva en wei
 */
function computeGasReserveRaw({ network, gasPriceWei = null }) {
  const floorRaw = ethers.parseUnits(getGasReserveAmount(network), 18);
  const gasPrice = gasPriceWei == null ? 0n : BigInt(gasPriceWei);
  if (gasPrice <= 0n) return floorRaw;

  const dynamicRaw = (BigInt(PLAN_GAS_UNITS_BUDGET) * gasPrice
    * GAS_RESERVE_SAFETY_NUMERATOR) / GAS_RESERVE_SAFETY_DENOMINATOR;
  return dynamicRaw > floorRaw ? dynamicRaw : floorRaw;
}

/**
 * Igual que `computeGasReserveRaw` pero resolviendo el gas price contra el RPC.
 * Best effort: si el provider no responde se cae al piso estático, que es el
 * comportamiento que había antes de que la reserva fuera dinámica.
 */
async function resolveGasReserveRaw({ provider, network }) {
  let gasPriceWei = null;
  try {
    const feeData = await provider.getFeeData();
    gasPriceWei = feeData.gasPrice || feeData.maxFeePerGas || null;
  } catch (feeErr) {
    logger.warn('gas_reserve_fee_data_failed', { network, error: feeErr?.message });
  }
  return computeGasReserveRaw({ network, gasPriceWei });
}

/**
 * Chequeo previo: el nativo que le queda al usuario después del fondeo tiene
 * que cubrir el gas del plan.
 *
 * La reserva por sí sola no alcanza como garantía, porque solo acota cuánto
 * nativo se puede *gastar* fondeando. Si el usuario fondea íntegramente con
 * ERC20 (USDC, por ejemplo) su ETH no se toca y el planner nunca mira si ese
 * ETH da para las txs. Sin este chequeo la falla aparece a mitad del plan, con
 * el swap ya pagado y sin posición creada.
 *
 * El camino de cierre ya validaba esto (`prepareCloseToUsdcV4`); el de creación
 * no lo hacía.
 */
function assertNativeCoversGas({
  network,
  nativeSymbol = 'ETH',
  nativeBalanceRaw,
  nativeUsedForFundingRaw = null,
  selectedFundingAssets = [],
  gasReserveRaw,
}) {
  const balance = BigInt(nativeBalanceRaw || 0n);
  // El nativo que se va al fondeo sale de los assets seleccionados, salvo que
  // el caller ya lo tenga sumado.
  const used = nativeUsedForFundingRaw != null
    ? BigInt(nativeUsedForFundingRaw)
    : selectedFundingAssets
      .filter((asset) => asset.isNative === true)
      .reduce((acc, asset) => acc + BigInt(asset.useAmountRaw || 0), 0n);
  const required = BigInt(gasReserveRaw || 0n);
  const leftover = balance > used ? balance - used : 0n;
  if (leftover >= required) return;

  const fmt = (raw) => ethers.formatUnits(raw, 18);
  const details = {
    network,
    nativeBalanceRaw: balance.toString(),
    nativeUsedForFundingRaw: used.toString(),
    requiredRaw: required.toString(),
  };
  logger.warn('smart_pool_creator_funding_plan_rejected', {
    code: 'INSUFFICIENT_NATIVE_FOR_GAS',
    network,
    nativeBalance: fmt(balance),
    nativeUsedForFunding: fmt(used),
    required: fmt(required),
  });
  throw new AppError(
    `No hay ${nativeSymbol} suficiente para pagar el gas de este plan: quedan `
    + `${fmt(leftover)} ${nativeSymbol} y se necesitan ~${fmt(required)} ${nativeSymbol}. `
    + `Cargá más ${nativeSymbol} o esperá a que baje el gas.`,
    { status: 400, code: 'INSUFFICIENT_NATIVE_FOR_GAS', details }
  );
}

module.exports = {
  GAS_RESERVE_BY_NETWORK,
  PLAN_GAS_UNITS_BUDGET,
  assertNativeCoversGas,
  computeGasReserveRaw,
  getGasReserveAmount,
  resolveGasReserveRaw,
};

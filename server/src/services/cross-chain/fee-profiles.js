/**
 * Perfiles de holgura de gas (Bajo / Medio / Alto).
 *
 * Unidad pura: recibe un `eth_feeHistory` y devuelve las fees EIP-1559 de cada
 * perfil. Lo que se paga es base + priority; `maxFeePerGas` y el margen de
 * `gasLimit` son topes que no se gastan pero sí bloquean nativo en la reserva.
 * Por eso un perfil mueve tres palancas: la priority fee (lo que se paga de
 * más), el tope ante subidas del base fee y el margen sobre el gas simulado.
 */

const { ValidationError } = require('../../errors/app-error');

const GWEI = 1_000_000_000n;

const PROFILE_IDS = ['low', 'medium', 'high'];

const PROFILES = {
  // p10 = la priority fee más baja que entró en los bloques recientes; el
  // tope aguanta dos bloques de subida máxima del base fee (1,125²).
  low: { id: 'low', label: 'Bajo', percentileIndex: 0, maxFeeNum: 81n, maxFeeDen: 64n, gasLimitBufferBps: 11_000n },
  medium: { id: 'medium', label: 'Medio', percentileIndex: 1, maxFeeNum: 2n, maxFeeDen: 1n, gasLimitBufferBps: 12_000n },
  high: { id: 'high', label: 'Alto', percentileIndex: 2, maxFeeNum: 3n, maxFeeDen: 1n, gasLimitBufferBps: 13_000n },
};

const FEE_HISTORY_BLOCKS = 20;
const FEE_HISTORY_PERCENTILES = [10, 50, 90];

// Orbit (Arbitrum y Robinhood, verificado con ArbSys) procesa por orden de
// llegada: la priority fee no compra nada. OP Stack cobra una tarifa de datos
// L1 aparte. Polygon exige una priority fee mínima.
const CHAIN_FAMILY = {
  ethereum: 'l1',
  arbitrum: 'orbit',
  robinhood: 'orbit',
  base: 'op',
  optimism: 'op',
  'base-sepolia': 'op',
  polygon: 'polygon',
};

const POLYGON_MIN_PRIORITY_WEI = 25n * GWEI;

// Reemplazo por nonce: los nodos exigen subir ambas fees al menos un 10 %;
// 12,5 % deja margen sobre ese mínimo.
const REPLACEMENT_BUMP_NUM = 1125n;
const REPLACEMENT_BUMP_DEN = 1000n;

function getProfile(id) {
  const profile = PROFILES[id];
  if (!profile) throw new ValidationError(`Perfil de gas desconocido: ${id}`);
  return profile;
}

function getChainFamily(network) {
  return CHAIN_FAMILY[String(network || '').toLowerCase()] || 'l1';
}

function medianBigInt(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function computeProfileFees({ network, profile, feeHistory }) {
  const config = getProfile(profile);
  const family = getChainFamily(network);
  const bases = (feeHistory?.baseFeePerGas || []).map((value) => BigInt(value));
  if (!bases.length) throw new Error('feeHistory sin baseFeePerGas');
  // `eth_feeHistory` devuelve un base fee más que bloques: el del siguiente.
  const baseFeeNextWei = bases[bases.length - 1];

  let priority = 0n;
  if (family !== 'orbit') {
    const column = (feeHistory.reward || [])
      .map((row) => row?.[config.percentileIndex])
      .filter((value) => value != null)
      .map((value) => BigInt(value));
    priority = column.length ? medianBigInt(column) : 0n;
    if (family === 'polygon' && priority < POLYGON_MIN_PRIORITY_WEI) priority = POLYGON_MIN_PRIORITY_WEI;
  }

  return {
    profile: config.id,
    family,
    baseFeeNextWei,
    maxPriorityFeePerGas: priority,
    maxFeePerGas: (baseFeeNextWei * config.maxFeeNum) / config.maxFeeDen + priority,
    expectedGasPriceWei: baseFeeNextWei + priority,
  };
}

function applyGasLimitBuffer(gasUnits, profile) {
  const { gasLimitBufferBps } = getProfile(profile);
  return (BigInt(gasUnits) * gasLimitBufferBps + 9_999n) / 10_000n;
}

function nextProfile(id) {
  const index = PROFILE_IDS.indexOf(getProfile(id).id);
  return PROFILE_IDS[Math.min(index + 1, PROFILE_IDS.length - 1)];
}

function bumpReplacementFees(previous, next) {
  const bump = (value) => (BigInt(value) * REPLACEMENT_BUMP_NUM + REPLACEMENT_BUMP_DEN - 1n) / REPLACEMENT_BUMP_DEN;
  const max = (a, b) => (a > b ? a : b);
  return {
    maxFeePerGas: max(BigInt(next.maxFeePerGas), bump(previous.maxFeePerGas)),
    maxPriorityFeePerGas: max(BigInt(next.maxPriorityFeePerGas), bump(previous.maxPriorityFeePerGas)),
  };
}

module.exports = {
  PROFILE_IDS,
  PROFILES,
  FEE_HISTORY_BLOCKS,
  FEE_HISTORY_PERCENTILES,
  POLYGON_MIN_PRIORITY_WEI,
  getProfile,
  getChainFamily,
  computeProfileFees,
  applyGasLimitBuffer,
  nextProfile,
  bumpReplacementFees,
};

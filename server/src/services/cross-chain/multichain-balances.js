/**
 * Saldos de la wallet en todas las redes de mainnet.
 *
 * Reutiliza la lectura por red del creador de pools (Multicall3 + precios).
 * Una red que falla o tarda no tumba el análisis: queda marcada como no
 * leída y el planificador la excluye con su motivo.
 */

const smartPoolCreatorService = require('../smart-pool-creator.service');
const { SUPPORTED_NETWORKS } = require('../uniswap/networks');
const { safeErrorMessage } = require('./safe-error');

const MAINNET_NETWORKS = Object.keys(SUPPORTED_NETWORKS).filter((id) => id !== 'base-sepolia');
const DEFAULT_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} tardó más de ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createMultichainBalances({
  getWalletAssets = (args) => smartPoolCreatorService.getWalletAssets(args),
  networks: defaultNetworks = MAINNET_NETWORKS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function readNetwork(network, walletAddress) {
    const config = SUPPORTED_NETWORKS[network];
    const base = {
      network,
      label: config?.label || network,
      chainId: config?.chainId || null,
      nativeSymbol: config?.nativeSymbol || 'ETH',
    };
    try {
      const result = await withTimeout(
        Promise.resolve().then(() => getWalletAssets({ network, walletAddress })),
        timeoutMs,
        `La lectura de ${base.label}`
      );
      return {
        ...base,
        status: 'ok',
        nativeBalanceRaw: String(result?.gasReserve?.nativeBalanceRaw || '0'),
        assets: result?.assets || [],
      };
    } catch (err) {
      return { ...base, status: 'error', error: safeErrorMessage(err), nativeBalanceRaw: '0', assets: [] };
    }
  }

  async function getMultichainBalances({ walletAddress, networks = defaultNetworks }) {
    const results = await Promise.all(networks.map((network) => readNetwork(network, walletAddress)));
    const totalUsd = results.reduce(
      (acc, entry) => acc + entry.assets.reduce((sum, asset) => sum + (Number(asset.usdValue) || 0), 0),
      0
    );
    return { networks: results, totalUsd };
  }

  return { getMultichainBalances };
}

module.exports = createMultichainBalances();
module.exports.createMultichainBalances = createMultichainBalances;
module.exports.MAINNET_NETWORKS = MAINNET_NETWORKS;

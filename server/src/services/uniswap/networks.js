/**
 * Definición canónica de redes soportadas por Uniswap.
 *
 * Centraliza las direcciones de contratos, RPCs y metadatos de cada red.
 * Importar desde aquí en vez de definir copias locales.
 */

const config = require('../../config');
const { ValidationError } = require('../../errors/app-error');

const RPC_DEFAULTS = config.uniswap.rpcUrls;
const FALLBACK_RPC_DEFAULTS = config.uniswap.fallbackRpcUrls;

const SUPPORTED_NETWORKS = {
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    chainId: 1,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://etherscan.io',
    rpcUrl: RPC_DEFAULTS.ethereum,
    fallbackRpcUrl: FALLBACK_RPC_DEFAULTS.ethereum,
    versions: ['v1', 'v2', 'v3', 'v4'],
    deployments: {
      v1: {
        kind: 'factory',
        eventSource: '0xc0a47dFe034B400B47bDaD5FecDa2621De6c4d95',
      },
      v2: {
        kind: 'factory',
        eventSource: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x000000000004444c5dc75cB358380D2e3dE08A90',
        stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
        positionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
      },
    },
  },
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum One',
    chainId: 42161,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://arbiscan.io',
    rpcUrl: RPC_DEFAULTS.arbitrum,
    fallbackRpcUrl: FALLBACK_RPC_DEFAULTS.arbitrum,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
        stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
        positionManager: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
      },
    },
  },
  base: {
    id: 'base',
    label: 'Base',
    chainId: 8453,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://basescan.org',
    rpcUrl: RPC_DEFAULTS.base,
    fallbackRpcUrl: FALLBACK_RPC_DEFAULTS.base,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
        positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x498581ff718922c3f8e6a244956af099b2652b2b',
        stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
        positionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
      },
    },
  },
  optimism: {
    id: 'optimism',
    label: 'Optimism',
    chainId: 10,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
    rpcUrl: RPC_DEFAULTS.optimism,
    fallbackRpcUrl: FALLBACK_RPC_DEFAULTS.optimism,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
        stateView: '0xc18a3169788f4f75a170290584eca6395c75ecdb',
        positionManager: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
      },
    },
  },
  polygon: {
    id: 'polygon',
    label: 'Polygon',
    chainId: 137,
    nativeSymbol: 'POL',
    explorerUrl: 'https://polygonscan.com',
    rpcUrl: RPC_DEFAULTS.polygon,
    fallbackRpcUrl: FALLBACK_RPC_DEFAULTS.polygon,
    versions: ['v2', 'v3', 'v4'],
    deployments: {
      v2: {
        kind: 'factory',
        eventSource: '0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C',
      },
      v3: {
        kind: 'factory',
        eventSource: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      },
      v4: {
        kind: 'poolManager',
        eventSource: '0x67366782805870060151383f4bbff9dab53e5cd6',
        stateView: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
        positionManager: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
      },
    },
  },
};

/**
 * Busca la configuración de una red por nombre (case-insensitive).
 * Lanza ValidationError si la red no existe.
 */
function getNetworkConfig(network) {
  const key = String(network || '').toLowerCase();
  const cfg = SUPPORTED_NETWORKS[key];
  if (!cfg) throw new ValidationError(`network no soportada: ${network}`);
  return cfg;
}

module.exports = { SUPPORTED_NETWORKS, getNetworkConfig };

import { arbitrum, base, mainnet, optimism, polygon } from 'wagmi/chains';
import { createPublicClient, fallback, http } from 'viem';

export const SUPPORTED_CHAINS = [mainnet, arbitrum, base, optimism, polygon];

const CHAIN_BY_ID = new Map(SUPPORTED_CHAINS.map((chain) => [Number(chain.id), chain]));

const DEFAULT_RPC_URLS = {
  [mainnet.id]: ['https://ethereum-rpc.publicnode.com', 'https://rpc.ankr.com/eth'],
  [arbitrum.id]: ['https://arbitrum-one-rpc.publicnode.com', 'https://rpc.ankr.com/arbitrum'],
  [base.id]: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  [optimism.id]: ['https://optimism-rpc.publicnode.com', 'https://rpc.ankr.com/optimism'],
  [polygon.id]: ['https://polygon-bor-rpc.publicnode.com', 'https://rpc.ankr.com/polygon'],
};

const ENV_RPC_URLS = {
  [mainnet.id]: import.meta.env.VITE_UNI_RPC_ETHEREUM,
  [arbitrum.id]: import.meta.env.VITE_UNI_RPC_ARBITRUM,
  [base.id]: import.meta.env.VITE_UNI_RPC_BASE,
  [optimism.id]: import.meta.env.VITE_UNI_RPC_OPTIMISM,
  [polygon.id]: import.meta.env.VITE_UNI_RPC_POLYGON,
};

const CLIENT_CACHE = new Map();

function buildRpcUrls(chainId) {
  const urls = [];
  const fromEnv = String(ENV_RPC_URLS[chainId] || '').trim();
  if (fromEnv) urls.push(fromEnv);
  for (const item of DEFAULT_RPC_URLS[chainId] || []) {
    if (item && !urls.includes(item)) {
      urls.push(item);
    }
  }
  return urls;
}

export function getChainById(chainId) {
  return CHAIN_BY_ID.get(Number(chainId)) || null;
}

export function createTransportForChain(chainId) {
  const urls = buildRpcUrls(chainId);
  return fallback(
    urls.map((url) => http(url)),
    {
      rank: true,
      retryCount: 3,
      retryDelay: 150,
    }
  );
}

export function getPublicClientForChain(chainId) {
  const normalizedChainId = Number(chainId);
  if (!Number.isFinite(normalizedChainId)) return null;
  if (CLIENT_CACHE.has(normalizedChainId)) {
    return CLIENT_CACHE.get(normalizedChainId);
  }
  const chain = getChainById(normalizedChainId);
  if (!chain) return null;
  const client = createPublicClient({
    chain,
    transport: createTransportForChain(normalizedChainId),
  });
  CLIENT_CACHE.set(normalizedChainId, client);
  return client;
}

export function buildWagmiTransports() {
  return Object.fromEntries(
    SUPPORTED_CHAINS.map((chain) => [chain.id, createTransportForChain(chain.id)])
  );
}

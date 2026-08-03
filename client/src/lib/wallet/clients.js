import { arbitrum, base, baseSepolia, mainnet, optimism, polygon } from 'wagmi/chains';
import { createPublicClient, fallback, http } from 'viem';

// baseSepolia es la testnet donde se validan los flujos on-chain. Tiene que
// estar aca ademas de en el networks.js del servidor: wagmi/WalletConnect solo
// declaran estas cadenas en la sesion, y pedir una tx de una cadena ausente
// hace que la wallet la rechace con "Missing or invalid parameters".
export const SUPPORTED_CHAINS = [mainnet, arbitrum, base, optimism, polygon, baseSepolia];

const CHAIN_BY_ID = new Map(SUPPORTED_CHAINS.map((chain) => [Number(chain.id), chain]));

// Un endpoint que exige API key NO puede estar en esta lista. `fallback` con
// `rank: true` rota entre las urls, asi que uno roto no falla siempre: falla a
// veces, en cualquier flujo (v3 y v4 por igual), sin relacion con la tx.
//
// Ankr paso a exigir API key y sus endpoints keyless devuelven **-32000**.
// viem mapea CUALQUIER -32000 a InvalidInputRpcError, cuyo mensaje fijo es
// "Missing or invalid parameters. Double check you have provided the correct
// parameters." — no dice una palabra de autenticacion. Ese texto se venia
// leyendo como si la tx tuviera los parametros mal, cuando el problema era el
// RPC. Verificado: los cinco endpoints de Ankr responden -32000 Unauthorized.
// El PRIMERO tiene que poder servir `eth_getTransactionReceipt` de bloques ya
// pasados: sin eso no se puede esperar la confirmacion de una tx. publicnode
// responde 403 "Archive requests require a personal token" en esas consultas
// aunque conteste bien la cabeza de la cadena, asi que queda de respaldo.
const DEFAULT_RPC_URLS = {
  [mainnet.id]: ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'],
  [arbitrum.id]: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
  [base.id]: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  [optimism.id]: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
  [polygon.id]: ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com'],
  [baseSepolia.id]: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
};

// Hosts que dejaron de servir sin API key. Un test bloquea que vuelvan a
// entrar: el sintoma que producen no se parece en nada a la causa.
export const RPC_HOSTS_BLOQUEADOS = ['ankr.com'];

const ENV_RPC_URLS = {
  [mainnet.id]: import.meta.env.VITE_UNI_RPC_ETHEREUM,
  [arbitrum.id]: import.meta.env.VITE_UNI_RPC_ARBITRUM,
  [base.id]: import.meta.env.VITE_UNI_RPC_BASE,
  [optimism.id]: import.meta.env.VITE_UNI_RPC_OPTIMISM,
  [polygon.id]: import.meta.env.VITE_UNI_RPC_POLYGON,
  [baseSepolia.id]: import.meta.env.VITE_UNI_RPC_BASE_SEPOLIA,
};

const CLIENT_CACHE = new Map();

export function buildRpcUrls(chainId) {
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
  // `rank: false` a proposito. Rankear reordena los transportes segun latencia
  // y hace que llamadas consecutivas caigan en nodos distintos. Para esperar
  // un recibo eso es veneno: se transmite por un nodo y se pregunta por el
  // recibo a otro que todavia no vio el bloque, asi que una tx que si entro
  // aparece como "no encontrada". Con orden estable se usa siempre el primero
  // y solo se cae al segundo si el primero falla.
  return fallback(
    urls.map((url) => http(url)),
    {
      rank: false,
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

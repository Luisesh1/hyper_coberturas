/**
 * Descubrimiento de los token IDs v4 que tiene una wallet.
 *
 * El PositionManager de v4 no es enumerable (no hay `tokenOfOwnerByIndex`),
 * así que hace falta un indexador. El primario es Etherscan (`tokennfttx`),
 * que además da la tx y el bloque de entrada de cada NFT. Su plan gratuito
 * no cubre todas las redes (Base responde "Free API access is not supported
 * for this chain"), así que el respaldo es la API NFT de Alchemy, derivada
 * del RPC de la red. Alchemy sólo da los IDs actuales: sin tx de entrada.
 */
const ALCHEMY_RPC_PATTERN = /^(https:\/\/[^/]+\.alchemy\.com)\/v2\/([^/?#]+)/i;
const ALCHEMY_PAGE_SIZE = 100;
const ALCHEMY_MAX_PAGES = 20;

function buildAlchemyNftBaseUrl(rpcUrl) {
  const match = String(rpcUrl || '').match(ALCHEMY_RPC_PATTERN);
  if (!match) return null;
  return `${match[1]}/nft/v3/${match[2]}`;
}

async function fetchTokenIdsFromAlchemy({ rpcUrl, wallet, contractAddress, http, timeoutMs = 15_000 }) {
  const baseUrl = buildAlchemyNftBaseUrl(rpcUrl);
  if (!baseUrl) {
    throw new Error('El RPC de la red no es de Alchemy; no hay API NFT de respaldo');
  }

  const tokenIds = [];
  let pageKey = null;
  for (let page = 0; page < ALCHEMY_MAX_PAGES; page += 1) {
    // Sin `excludeFilters[]=SPAM`: Alchemy marca como spam los NFT de
    // posición de Uniswap (metadata on-chain) y los descartaría.
    const params = {
      owner: wallet,
      'contractAddresses[]': contractAddress,
      withMetadata: false,
      pageSize: ALCHEMY_PAGE_SIZE,
      ...(pageKey ? { pageKey } : {}),
    };
    const { data } = await http.get(`${baseUrl}/getNFTsForOwner`, { params, timeout: timeoutMs });
    for (const nft of data?.ownedNfts || []) {
      if (nft?.tokenId != null) tokenIds.push(String(BigInt(nft.tokenId)));
    }
    pageKey = data?.pageKey || null;
    if (!pageKey) break;
  }
  return tokenIds;
}

/**
 * @param {object} deps
 * @param {(() => Promise<{tokenIds: string[], firstInbound: Map, truncated: boolean}>) | null} deps.etherscanLookup
 *   null cuando el usuario no tiene API key de Etherscan.
 * @param {() => Promise<string[]>} deps.alchemyLookup
 */
async function discoverV4TokenIds({ etherscanLookup, alchemyLookup }) {
  let etherscanError = null;
  if (etherscanLookup) {
    try {
      const result = await etherscanLookup();
      return { ...result, source: 'etherscan', warning: null };
    } catch (err) {
      etherscanError = err;
    }
  }

  try {
    const tokenIds = await alchemyLookup();
    const reason = etherscanError ? etherscanError.message : 'sin API key de Etherscan';
    return {
      tokenIds,
      firstInbound: new Map(),
      truncated: false,
      source: 'alchemy_nft',
      warning: `Etherscan no disponible (${reason}); posiciones v4 obtenidas de Alchemy sin fecha de apertura`,
    };
  } catch (alchemyError) {
    throw etherscanError || alchemyError;
  }
}

module.exports = {
  buildAlchemyNftBaseUrl,
  fetchTokenIdsFromAlchemy,
  discoverV4TokenIds,
};

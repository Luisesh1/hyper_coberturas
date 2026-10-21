/**
 * Descubrimiento de los token IDs v4 que tiene una wallet.
 *
 * El PositionManager de v4 no es enumerable (no hay `tokenOfOwnerByIndex`),
 * así que hace falta un indexador. El primario es Etherscan (`tokennfttx`),
 * que además da la tx y el bloque de entrada de cada NFT. Su plan gratuito
 * no cubre todas las redes (Base responde "Free API access is not supported
 * for this chain"), así que el respaldo es la API NFT de Alchemy, derivada
 * del RPC de la red. Alchemy sólo da los IDs actuales: sin tx de entrada.
 * Si tampoco hay API NFT (red no habilitada en Alchemy, o red sin soporte),
 * el último recurso son los eventos `Transfer` del PositionManager leídos con
 * `eth_getLogs` en un RPC público: lento, pero no depende de nadie.
 */
const { ethers } = require('ethers');

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

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const LOGS_MAX_RANGE = 10_000_000;
const LOGS_MIN_RANGE = 10_000;
// Mensajes con los que los RPC rechazan un rango demasiado grande o con
// demasiados resultados; ante ellos se parte el tramo en vez de fallar.
const LOGS_RANGE_ERROR = /range|limit|exceed|too many|narrow|10000 results|response size/i;

function addressTopic(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

async function getLogsAdaptive(provider, filter, fromBlock, toBlock, maxRange) {
  const logs = [];
  let range = maxRange;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + range - 1, toBlock);
    try {
      logs.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
      start = end + 1;
    } catch (err) {
      if (range <= LOGS_MIN_RANGE || !LOGS_RANGE_ERROR.test(String(err?.message || err))) throw err;
      range = Math.max(LOGS_MIN_RANGE, Math.floor(range / 2));
    }
  }
  return logs;
}

/**
 * Reconstruye los NFT que tiene la wallet a partir de sus `Transfer` de
 * entrada y salida, en orden. Devuelve el mismo formato que Etherscan
 * (`tokenIds` + `firstInbound`), incluida la fecha de apertura.
 */
async function fetchTokenIdsFromLogs({ provider, wallet, contractAddress, fromBlock = 0, maxRange = LOGS_MAX_RANGE }) {
  const latest = await provider.getBlockNumber();
  const walletTopic = addressTopic(wallet);
  const [inbound, outbound] = await Promise.all([
    getLogsAdaptive(provider, { address: contractAddress, topics: [TRANSFER_TOPIC, null, walletTopic] }, fromBlock, latest, maxRange),
    getLogsAdaptive(provider, { address: contractAddress, topics: [TRANSFER_TOPIC, walletTopic] }, fromBlock, latest, maxRange),
  ]);

  const events = [
    ...inbound.map((log) => ({ log, inbound: true })),
    ...outbound.map((log) => ({ log, inbound: false })),
  ].sort((a, b) => (a.log.blockNumber - b.log.blockNumber) || (a.log.index - b.log.index) || (a.inbound - b.inbound));

  const ownership = new Map();
  const firstInbound = new Map();
  for (const { log, inbound: isInbound } of events) {
    const tokenId = String(BigInt(log.topics[3]));
    ownership.set(tokenId, isInbound);
    if (isInbound && !firstInbound.has(tokenId)) {
      firstInbound.set(tokenId, { txHash: log.transactionHash, blockNumber: log.blockNumber, createdAt: null });
    }
  }

  const tokenIds = [...ownership.entries()].filter(([, owned]) => owned).map(([tokenId]) => tokenId);
  for (const tokenId of tokenIds) {
    const entry = firstInbound.get(tokenId);
    if (!entry) continue;
    const block = await provider.getBlock(entry.blockNumber).catch(() => null);
    entry.createdAt = block?.timestamp ?? null;
  }
  return { tokenIds, firstInbound };
}

/**
 * @param {object} deps
 * @param {(() => Promise<{tokenIds: string[], firstInbound: Map, truncated: boolean}>) | null} deps.etherscanLookup
 *   null cuando el usuario no tiene API key de Etherscan.
 * @param {() => Promise<string[]>} deps.alchemyLookup
 * @param {(() => Promise<{tokenIds: string[], firstInbound: Map}>) | null} [deps.logsLookup]
 *   último recurso: eventos on-chain; null si no hay RPC que lo permita.
 */
async function discoverV4TokenIds({ etherscanLookup, alchemyLookup, logsLookup = null }) {
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
    if (logsLookup) {
      try {
        const result = await logsLookup();
        const reasons = [etherscanError ? `Etherscan: ${etherscanError.message}` : null, `Alchemy: ${alchemyError.message}`]
          .filter(Boolean).join('; ');
        return {
          ...result,
          truncated: false,
          source: 'onchain_logs',
          warning: `Sin indexador (${reasons}); posiciones v4 obtenidas de los eventos on-chain`,
        };
      } catch (logsError) {
        alchemyError.message = `${alchemyError.message}; respaldo on-chain: ${logsError.message}`;
      }
    }
    if (!etherscanError) throw alchemyError;
    // Se conserva el error (y su tipo) de Etherscan, pero sin esconder por
    // qué tampoco sirvieron los respaldos.
    etherscanError.message = `${etherscanError.message} (respaldo Alchemy: ${alchemyError.message})`;
    throw etherscanError;
  }
}

module.exports = {
  buildAlchemyNftBaseUrl,
  fetchTokenIdsFromAlchemy,
  fetchTokenIdsFromLogs,
  discoverV4TokenIds,
};

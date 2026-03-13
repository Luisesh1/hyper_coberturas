const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  computeRangeVisual,
  decodeV4PositionInfo,
  estimateTvlApproxUsd,
  getSupportMatrix,
  parseCreationLogs,
  resolveHistoricalSpotPrice,
  SUPPORTED_NETWORKS,
  tickToPrice,
} = require('../src/services/uniswap.service');

function buildReceiptLog(version, address, values) {
  const abiByVersion = {
    v1: ['event NewExchange(address indexed token, address indexed exchange)'],
    v2: ['event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'],
    v3: ['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'],
    v4: ['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'],
  };

  const iface = new ethers.Interface(abiByVersion[version]);
  const eventName = version === 'v1'
    ? 'NewExchange'
    : version === 'v2'
      ? 'PairCreated'
      : version === 'v3'
        ? 'PoolCreated'
        : 'Initialize';
  const encoded = iface.encodeEventLog(iface.getEvent(eventName), values);

  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    index: 0,
  };
}

test('support matrix expone redes populares con versiones soportadas', () => {
  const matrix = getSupportMatrix();

  assert.deepEqual(matrix.versions, ['v1', 'v2', 'v3', 'v4']);
  assert.deepEqual(
    matrix.networks.map((network) => network.id),
    ['ethereum', 'arbitrum', 'base', 'optimism', 'polygon']
  );
  assert.ok(matrix.networks.find((network) => network.id === 'ethereum').versions.includes('v1'));
  assert.ok(!matrix.networks.find((network) => network.id === 'arbitrum').versions.includes('v1'));
});

test('supported networks incluye deployments oficiales relevantes', () => {
  assert.equal(
    SUPPORTED_NETWORKS.polygon.deployments.v4.eventSource,
    '0x67366782805870060151383f4bbff9dab53e5cd6'
  );
  assert.equal(
    SUPPORTED_NETWORKS.base.deployments.v3.eventSource,
    '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
  );
});

test('parseCreationLogs reconoce evento v2', () => {
  const address = SUPPORTED_NETWORKS.ethereum.deployments.v2.eventSource;
  const receipt = {
    logs: [
      buildReceiptLog('v2', address, [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        1n,
      ]),
    ],
  };

  const parsed = parseCreationLogs('v2', receipt, address);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].parsed.name, 'PairCreated');
});

test('parseCreationLogs reconoce evento v4', () => {
  const address = SUPPORTED_NETWORKS.polygon.deployments.v4.eventSource;
  const receipt = {
    logs: [
      buildReceiptLog('v4', address, [
        `0x${'11'.repeat(32)}`,
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000002',
        3000,
        60,
        '0x0000000000000000000000000000000000000003',
        123n,
        10,
      ]),
    ],
  };

  const parsed = parseCreationLogs('v4', receipt, address);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].parsed.name, 'Initialize');
});

test('tickToPrice convierte tick a precio aproximado', () => {
  const price = tickToPrice(-200400, 18, 6);
  assert.ok(price > 1900 && price < 2000);
});

test('estimateTvlApproxUsd infiere TVL cuando hay stablecoin', () => {
  const tvl = estimateTvlApproxUsd(
    { symbol: 'WETH' },
    '1.5',
    { symbol: 'USDC' },
    '3000'
  );
  assert.equal(tvl, 6000);
});

test('decodeV4PositionInfo extrae tickLower y tickUpper del packed info', () => {
  const poolIdPart = BigInt(`0x${'11'.repeat(25)}`) << 56n;
  const tickLowerEncoded = BigInt(0x1000000 + (-200000));
  const tickUpperEncoded = 200400n;
  const packed =
    poolIdPart |
    (tickUpperEncoded << 32n) |
    (tickLowerEncoded << 8n);

  const decoded = decodeV4PositionInfo(packed);
  assert.equal(decoded.tickLower, -200000);
  assert.equal(decoded.tickUpper, 200400);
  assert.equal(decoded.hasSubscriber, false);
});

test('resolveHistoricalSpotPrice usa lectura exacta si el bloque esta disponible', async () => {
  const result = await resolveHistoricalSpotPrice({
    blockNumber: 1000,
    fetchAtBlock: async (block) => ({ tick: block, price: 123.4567 }),
  });

  assert.equal(result.accuracy, 'exact');
  assert.equal(result.blockNumber, 1000);
  assert.equal(result.price, 123.4567);
});

test('resolveHistoricalSpotPrice cae a bloque aproximado cuando el exacto falla', async () => {
  const result = await resolveHistoricalSpotPrice({
    blockNumber: 1000,
    fetchAtBlock: async (block) => {
      if (block < 1250) {
        throw new Error('historical state unavailable');
      }
      return { tick: 55, price: 98.7654 };
    },
  });

  assert.equal(result.accuracy, 'approximate');
  assert.equal(result.blockNumber, 1250);
  assert.equal(result.tick, 55);
});

test('resolveHistoricalSpotPrice devuelve unavailable si ningun bloque responde', async () => {
  const result = await resolveHistoricalSpotPrice({
    blockNumber: 1000,
    fetchAtBlock: async () => {
      throw new Error('historical state unavailable');
    },
  });

  assert.equal(result.accuracy, 'unavailable');
  assert.equal(result.price, null);
  assert.equal(result.blockNumber, null);
});

test('computeRangeVisual detecta cuando el precio actual sale por arriba del rango', () => {
  const visual = computeRangeVisual(1900, 2100, 1950, 2150);
  assert.equal(visual.currentOutOfRangeSide, 'above');
  assert.equal(visual.openMarkerPct, 25);
  assert.equal(visual.currentMarkerPct, 100);
});

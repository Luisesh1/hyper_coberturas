/**
 * Fondeo cross-chain del asistente LP: análisis, alta del plan y ejecución
 * paso a paso. Fase 1 de dos: trae a la red del LP lo que falta de cada lado;
 * la fase 2 es el `buildFundingPlan` de siempre sobre lo que llegó.
 *
 * Spec: docs/superpowers/specs/2026-10-05-cross-chain-funding-design.md
 */

const { ethers } = require('ethers');
const { AppError, ValidationError } = require('../../errors/app-error');
const logger = require('../logger.service');
const { getNetworkConfig } = require('../uniswap/networks');
const { PROFILE_IDS, nextProfile, bumpReplacementFees } = require('./fee-profiles');
const { computeSideDeficits, deliveryTokenFor } = require('./side-deficits');
const { usdPriceForSymbol } = require('./pricing');
const { ZERO_ADDRESS } = require('./bridge-planner');

const DEFAULT_THRESHOLD_PCT = 3;
const DEFAULT_SLIPPAGE_BPS = 50;
// Si el costo recotizado al firmar supera en más de esto al mostrado, se pide confirmar.
const RECONFIRM_RATIO = 1.2;
const RECONFIRM_MIN_DELTA_USD = 0.01;
// Un paso en vuelo es «lento» si tarda más del doble de lo estimado (+1 min).
const SLOW_GRACE_MS = 60_000;

const LP_TX_KINDS = {
  v4: [
    ['approval', 'Aprobar token 0'],
    ['approval', 'Aprobar token 1'],
    ['permit2_approval', 'Permit2 token 0'],
    ['permit2_approval', 'Permit2 token 1'],
    ['mint_position_v4', 'Crear el LP'],
  ],
  v3: [
    ['approval', 'Aprobar token 0'],
    ['approval', 'Aprobar token 1'],
    ['mint_position', 'Crear el LP'],
  ],
};

function lower(value) {
  return String(value || '').toLowerCase();
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function sourceIdFor(network, asset) {
  return `${network}:${asset.isNative ? 'native' : lower(asset.address)}`;
}

function assetAddress(asset) {
  return asset.isNative ? ZERO_ADDRESS : asset.address;
}

/** Quita el calldata y las cotizaciones crudas: lo que ve el navegador. */
function toPublicAnalysis(analysis) {
  if (!analysis) return analysis;
  return {
    ...analysis,
    steps: (analysis.steps || []).map(({ quote, txs, ...step }) => ({
      ...step,
      costs: step.costs
        ? {
          ...step.costs,
          gasOrigin: step.costs.gasOrigin
            ? { ...step.costs.gasOrigin, txs: (step.costs.gasOrigin.txs || []).map(({ kind, label, expectedUsd, maxUsd, source, l1Usd }) => ({ kind, label, expectedUsd, maxUsd, source, l1Usd })) }
            : step.costs.gasOrigin,
        }
        : step.costs,
    })),
  };
}

function createCrossChainFundingService({
  balances,
  feeOracle,
  planner,
  repo,
  providers,
  getPrices,
  getWrappedNativeToken,
  getProvider = null,
  now = Date.now,
}) {
  async function estimateLp({ network, version, nativeUsdPrice }) {
    const kinds = LP_TX_KINDS[String(version).toLowerCase()] || LP_TX_KINDS.v4;
    const txs = kinds.map(([kind, label]) => ({ kind, label }));
    const entries = await Promise.all(PROFILE_IDS.map(async (profile) => [
      profile,
      await feeOracle.estimateTxCosts({ network, profile, txs, nativeUsdPrice }),
    ]));
    return Object.fromEntries(entries);
  }

  async function analyze(input) {
    const profile = input.profile || 'low';
    if (!PROFILE_IDS.includes(profile)) throw new ValidationError(`Perfil de gas desconocido: ${profile}`);
    const thresholdPct = input.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
    const maxSlippageBps = input.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const network = input.network;
    const destConfig = getNetworkConfig(network);
    const target = Number(input.totalUsdTarget);

    const [prices, multichain] = await Promise.all([
      getPrices().catch(() => ({})),
      balances.getMultichainBalances({ walletAddress: input.walletAddress }),
    ]);
    const dest = multichain.networks.find((entry) => entry.network === network);
    if (!dest || dest.status !== 'ok') {
      throw new AppError(
        `No se pudieron leer los saldos de ${destConfig.label}: ${dest?.error || 'red no disponible'}.`,
        { status: 502, code: 'DESTINATION_UNREADABLE' }
      );
    }

    const nativePrices = Object.fromEntries(multichain.networks.map((entry) => [
      entry.network,
      usdPriceForSymbol(entry.nativeSymbol, prices),
    ]));
    const nativePriceUsd = nativePrices[network];

    const lpByProfile = await estimateLp({ network, version: input.version, nativeUsdPrice: nativePriceUsd });
    const gasNeededRaw = BigInt(lpByProfile[profile].totalMaxWei || 0);
    const destNativeRaw = BigInt(dest.nativeBalanceRaw || 0);

    const wrapped = getWrappedNativeToken(network);
    const localAssets = dest.assets.map((asset) => {
      if (!asset.isNative) {
        return { address: asset.address, isNative: false, usableUsd: Number(asset.usdValue) || 0 };
      }
      const usableRaw = destNativeRaw > gasNeededRaw ? destNativeRaw - gasNeededRaw : 0n;
      const price = asset.usdPrice ?? nativePriceUsd;
      return {
        address: ZERO_ADDRESS,
        isNative: true,
        usableUsd: price != null ? Number(ethers.formatEther(usableRaw)) * price : 0,
      };
    });

    const deficits = computeSideDeficits({
      targetUsd: target,
      weightToken0Pct: Number(input.targetWeightToken0Pct),
      token0: input.token0,
      token1: input.token1,
      localAssets,
      wrappedNativeAddress: wrapped?.address || null,
    });

    const destinationView = {
      network,
      label: destConfig.label,
      nativeSymbol: destConfig.nativeSymbol,
      nativeBalanceRaw: destNativeRaw.toString(),
      gasNeededRaw: gasNeededRaw.toString(),
      lacksGas: destNativeRaw < gasNeededRaw,
      localUsableUsd: round(deficits.localUsableUsd, 2),
      needUsd: { token0: round(deficits.needUsd.token0, 2), token1: round(deficits.needUsd.token1, 2) },
      deficitUsd: { token0: round(deficits.deficitUsd.token0, 2), token1: round(deficits.deficitUsd.token1, 2) },
    };

    // Orígenes: saldos de las demás redes leídas.
    const sources = [];
    for (const entry of multichain.networks) {
      if (entry.network === network || entry.status !== 'ok') continue;
      for (const asset of entry.assets) {
        if (BigInt(asset.balanceRaw || 0) <= 0n) continue;
        sources.push({
          id: sourceIdFor(entry.network, asset),
          network: entry.network,
          address: assetAddress(asset),
          symbol: asset.symbol,
          decimals: Number(asset.decimals ?? 18),
          isNative: asset.isNative === true,
          balanceRaw: String(asset.balanceRaw),
          priceUsd: asset.usdPrice ?? usdPriceForSymbol(asset.symbol, prices),
        });
      }
    }

    let plan = { steps: [], sourcesView: [], deliveredUsd: 0, uncoveredUsd: 0, costsByProfile: null };
    if (deficits.needsCrossChain) {
      const sides = ['token0', 'token1']
        .filter((side) => deficits.deficitUsd[side] > 0)
        .map((side) => {
          const delivery = deliveryTokenFor(input[side], {
            wrappedNativeAddress: wrapped?.address || null,
            nativeSymbol: destConfig.nativeSymbol,
          });
          return {
            side,
            deficitUsd: deficits.deficitUsd[side],
            deliveryToken: { ...delivery, priceUsd: usdPriceForSymbol(delivery.symbol, prices) },
          };
        });
      plan = await planner.buildBridgePlan({
        walletAddress: input.walletAddress,
        destination: {
          network,
          nativeSymbol: destConfig.nativeSymbol,
          nativeBalanceRaw: destNativeRaw.toString(),
          gasNeededRaw: gasNeededRaw.toString(),
          nativePriceUsd,
          sides,
        },
        sources,
        profile,
        thresholdPct,
        forcedSources: input.forcedSources || [],
        disabledSources: input.disabledSources || [],
        maxSlippageBps,
        providers: Object.values(providers || {}),
        feeOracle,
        nativePrices,
      });
    }

    // Swaps de la fase 2: los activos locales que no son de ningún lado.
    const swapCount = deficits.otherLocalUsd > 0
      ? dest.assets.filter((asset) => !asset.isNative
        && lower(asset.address) !== lower(input.token0.address)
        && lower(asset.address) !== lower(input.token1.address)
        && Number(asset.usdValue) > 0).length
      : 0;
    const swapsByProfile = {};
    for (const id of PROFILE_IDS) {
      if (!swapCount) {
        swapsByProfile[id] = { expectedUsd: 0, maxUsd: 0 };
        continue;
      }
      const swaps = await feeOracle.estimateTxCosts({
        network,
        profile: id,
        txs: Array.from({ length: swapCount }, () => ({ kind: 'swap', label: 'Swap local' })),
        nativeUsdPrice: nativePriceUsd,
      });
      swapsByProfile[id] = { expectedUsd: round(swaps.totalExpectedUsd ?? 0), maxUsd: round(swaps.totalMaxUsd ?? 0) };
    }

    const byProfile = {};
    for (const id of PROFILE_IDS) {
      const bridge = plan.costsByProfile?.[id] || { gasOriginExpectedUsd: 0, gasOriginMaxUsd: 0, bridgeCostUsd: 0 };
      const lp = lpByProfile[id];
      const gasOrigin = { expectedUsd: bridge.gasOriginExpectedUsd, maxUsd: bridge.gasOriginMaxUsd };
      const gasDestination = { expectedUsd: round(lp.totalExpectedUsd ?? 0), maxUsd: round(lp.totalMaxUsd ?? 0) };
      const swaps = swapsByProfile[id];
      const totalExpectedUsd = gasOrigin.expectedUsd + bridge.bridgeCostUsd + gasDestination.expectedUsd + swaps.expectedUsd;
      const totalMaxUsd = gasOrigin.maxUsd + bridge.bridgeCostUsd + gasDestination.maxUsd + swaps.maxUsd;
      byProfile[id] = {
        gasOrigin,
        bridgeUsd: bridge.bridgeCostUsd,
        gasDestination,
        swaps,
        totalExpectedUsd: round(totalExpectedUsd),
        totalMaxUsd: round(totalMaxUsd),
        pctOfTarget: target > 0 ? (round(totalExpectedUsd) / target) * 100 : null,
      };
    }

    const viewById = new Map(plan.sourcesView.map((row) => [row.id, row]));
    const networksView = multichain.networks.map((entry) => ({
      network: entry.network,
      label: entry.label,
      chainId: entry.chainId,
      nativeSymbol: entry.nativeSymbol,
      status: entry.status,
      error: entry.error || null,
      isDestination: entry.network === network,
      profilesMatter: entry.network === network ? lpByProfile[profile].profilesMatter !== false : undefined,
      rows: entry.assets.map((asset) => {
        const id = sourceIdFor(entry.network, asset);
        const planned = viewById.get(id);
        const base = {
          id,
          symbol: asset.symbol,
          decimals: Number(asset.decimals ?? 18),
          isNative: asset.isNative === true,
          balanceRaw: String(asset.balanceRaw),
          usd: asset.usdValue != null ? round(Number(asset.usdValue), 2) : null,
        };
        if (entry.network === network) {
          return { ...base, role: 'destination', reason: 'Se usa directo en el LP', usedAmountRaw: '0' };
        }
        if (!planned) {
          return { ...base, role: deficits.needsCrossChain ? 'not_needed' : 'idle', reason: '', usedAmountRaw: '0' };
        }
        return {
          ...base,
          role: planned.role,
          reason: planned.reason,
          usedAmountRaw: planned.usedAmountRaw || '0',
          forced: planned.forced === true,
        };
      }),
    }));

    return {
      generatedAt: now(),
      needsCrossChain: deficits.needsCrossChain,
      profile,
      thresholdPct,
      maxSlippageBps,
      totalUsdTarget: target,
      destination: destinationView,
      balances: { networks: networksView, totalUsd: round(multichain.totalUsd, 2) },
      steps: plan.steps,
      lpTxs: lpByProfile[profile].txs.map(({ kind, label, expectedUsd, maxUsd, source }) => ({ kind, label, expectedUsd, maxUsd, source })),
      deliveredUsd: plan.deliveredUsd,
      uncoveredUsd: plan.uncoveredUsd,
      deployableUsd: round(Math.min(target, deficits.localUsableUsd + plan.deliveredUsd), 2),
      costs: { byProfile, selected: byProfile[profile] },
    };
  }

  async function createPlan({ userId, input }) {
    const active = await repo.findActivePlan(userId, input.walletAddress);
    if (active) {
      throw new AppError('Ya hay un plan de fondeo en curso para esta wallet.', { status: 409, code: 'ACTIVE_PLAN_EXISTS', details: { planId: active.id } });
    }
    const analysis = await analyze(input);
    if (!analysis.needsCrossChain) {
      throw new AppError('Los fondos de la red del LP ya alcanzan: no hace falta traer nada.', { status: 400, code: 'NO_CROSS_CHAIN_NEEDED' });
    }
    if (!analysis.steps.length) {
      throw new AppError('Ningún origen tiene una ruta viable bajo el umbral de costo.', { status: 400, code: 'NO_VIABLE_ROUTE' });
    }
    return repo.createPlan({
      userId,
      walletAddress: input.walletAddress,
      destinationNetwork: input.network,
      profile: analysis.profile,
      thresholdPct: analysis.thresholdPct,
      request: input,
      analysis: toPublicAnalysis(analysis),
      steps: analysis.steps.map((step) => ({
        ...step,
        quoteSnapshot: {
          quote: step.quote,
          txs: step.txs,
          sourceId: step.sourceId,
          side: step.side,
          amountUsd: step.amountUsd,
          receivedUsd: step.receivedUsd,
          deliveryToken: step.deliveryToken,
          costs: step.costs,
          alternative: step.alternative,
          slippageBps: analysis.maxSlippageBps,
        },
      })),
    });
  }

  return {
    analyze,
    createPlan,
    toPublicAnalysis,
    // Usados por la parte de ejecución (más abajo) y sus tests.
    _deps: { balances, feeOracle, planner, repo, providers, getPrices, getWrappedNativeToken, getProvider, now },
  };
}

module.exports = {
  createCrossChainFundingService,
  toPublicAnalysis,
  LP_TX_KINDS,
  RECONFIRM_RATIO,
  RECONFIRM_MIN_DELTA_USD,
  SLOW_GRACE_MS,
  // Reexportados para la ejecución.
  _internal: { nextProfile, bumpReplacementFees, logger },
};

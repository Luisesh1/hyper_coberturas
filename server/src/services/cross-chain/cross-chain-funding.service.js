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
const { computeSideDeficits, deliveryTokenFor, isDirectFor } = require('./side-deficits');
const { usdPriceForSymbol } = require('./pricing');
const { ZERO_ADDRESS, bridgeTxsFor, rawToUsd } = require('./bridge-planner');
const { safeErrorMessage } = require('./safe-error');

const ERC20_ALLOWANCE = new ethers.Interface(['function allowance(address owner, address spender) view returns (uint256)']);
const ERC20_BALANCE = new ethers.Interface(['function balanceOf(address owner) view returns (uint256)']);
const IN_FLIGHT = new Set(['signed', 'source_confirmed']);

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
    steps: (analysis.steps || []).map(({ quote: _quote, txs: _txs, ...step }) => ({
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

    let lpByProfile;
    try {
      lpByProfile = await estimateLp({ network, version: input.version, nativeUsdPrice: nativePriceUsd });
    } catch (err) {
      throw new AppError(
        `No se pudo leer el gas de ${destConfig.label}: ${safeErrorMessage(err)}.`,
        { status: 502, code: 'DESTINATION_UNREADABLE' }
      );
    }
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
        && !isDirectFor(asset, input.token0, wrapped?.address || null)
        && !isDirectFor(asset, input.token1, wrapped?.address || null)
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
          // Lo que vio el usuario: la reconfirmación siempre se mide contra esto.
          shownCostUsd: step.costs?.expectedUsd ?? null,
          alternative: step.alternative,
          slippageBps: analysis.maxSlippageBps,
        },
      })),
    });
  }

  // ── Ejecución ────────────────────────────────────────────────────────

  function notFound() {
    return new AppError('Plan de fondeo no encontrado.', { status: 404, code: 'PLAN_NOT_FOUND' });
  }

  async function loadPlan(userId, planId) {
    const plan = await repo.getPlan(userId, planId);
    if (!plan) throw notFound();
    return plan;
  }

  function findStep(plan, order) {
    const step = plan.steps.find((entry) => entry.order === Number(order));
    if (!step) throw new AppError('Paso no encontrado.', { status: 404, code: 'STEP_NOT_FOUND' });
    return step;
  }

  function assertExecuting(plan) {
    if (plan.status !== 'executing') {
      throw new AppError('El plan ya no está en curso.', { status: 409, code: 'PLAN_NOT_ACTIVE' });
    }
  }

  function unitPriceFromSnapshot(step) {
    const snapshot = step.quote || {};
    const units = Number(ethers.formatUnits(BigInt(step.amountRaw), step.token.decimals));
    return units > 0 && snapshot.amountUsd != null ? snapshot.amountUsd / units : null;
  }

  async function quoteWithFallback(step, plan, amountRaw) {
    const args = {
      fromNetwork: step.sourceNetwork,
      toNetwork: plan.destinationNetwork,
      fromToken: step.token.isNative ? ZERO_ADDRESS : step.token.address,
      toToken: step.deliveryTokenAddress,
      fromAmountRaw: amountRaw.toString(),
      walletAddress: plan.walletAddress,
      slippageBps: step.quote?.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    };
    const ordered = [providers[step.provider], ...Object.values(providers).filter((p) => p.id !== step.provider)].filter(Boolean);
    let firstError = null;
    for (const provider of ordered) {
      try {
        return await provider.quote(args);
      } catch (err) {
        firstError = firstError || err;
        logger.warn('cross_chain_requote_failed', { provider: provider.id, planId: plan.id, order: step.order, error: err?.message });
      }
    }
    throw firstError;
  }

  async function dropSatisfiedApprovals(rpc, plan, approvals, amountRaw) {
    const needed = [];
    for (const approval of approvals) {
      try {
        const out = await rpc.call({
          to: approval.to,
          data: ERC20_ALLOWANCE.encodeFunctionData('allowance', [plan.walletAddress, approval.spender]),
        });
        const [allowance] = ERC20_ALLOWANCE.decodeFunctionResult('allowance', out);
        if (BigInt(allowance) >= BigInt(amountRaw)) continue;
      } catch {
        // Sin lectura de allowance se pide el approve: nunca de menos.
      }
      needed.push(approval);
    }
    return needed;
  }

  function signable(tx, { chainId, gasLimit, fees, nonce = null, replacement = false }) {
    return {
      kind: tx.kind,
      label: tx.label || tx.kind,
      chainId,
      to: tx.to,
      data: tx.data,
      value: String(tx.value || '0'),
      gas: String(gasLimit),
      maxFeePerGas: String(fees.maxFeePerGas),
      maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
      ...(nonce != null ? { nonce } : {}),
      ...(replacement ? { replacement: true } : {}),
    };
  }

  async function prepareSpeedUp(plan, step) {
    if (step.status !== 'signed' || step.nonce == null || !step.sentFees) {
      throw new AppError('Solo se puede acelerar un envío firmado que aún no entró en un bloque.', { status: 409, code: 'STEP_NOT_REPLACEABLE' });
    }
    const profile = nextProfile(step.sentFees.profile || plan.profile);
    const fees = await feeOracle.getProfileFees({ network: step.sourceNetwork, profile });
    const bumped = bumpReplacementFees(step.sentFees, fees);
    const bridgeTx = (step.quote?.txs || []).find((tx) => tx.kind === 'bridge');
    const gasLimit = step.sentFees.gasLimit || bridgeTx?.providerGasLimit || '300000';
    return {
      requiresReconfirm: false,
      speedUp: true,
      profile,
      txs: [signable(bridgeTx, {
        chainId: getNetworkConfig(step.sourceNetwork).chainId,
        gasLimit,
        fees: bumped,
        nonce: step.nonce,
        replacement: true,
      })],
    };
  }

  async function prepareStep({ userId, planId, order, speedUp = false }) {
    const plan = await loadPlan(userId, planId);
    assertExecuting(plan);
    const step = findStep(plan, order);
    if (speedUp) return prepareSpeedUp(plan, step);
    if (step.status !== 'pending') {
      throw new AppError('Este paso ya se envió: no se firma otra vez.', { status: 409, code: 'STEP_ALREADY_SUBMITTED' });
    }
    const earlierPending = plan.steps.some((entry) => entry.sourceNetwork === step.sourceNetwork
      && entry.order < step.order && entry.status === 'pending');
    if (earlierPending) {
      throw new AppError('Primero hay que enviar los pasos anteriores de esta red.', { status: 409, code: 'STEP_OUT_OF_ORDER' });
    }

    const network = step.sourceNetwork;
    const rpc = getProvider(network);
    const prices = await getPrices().catch(() => ({}));
    const nativePrice = usdPriceForSymbol(getNetworkConfig(network).nativeSymbol, prices);
    let amountRaw = BigInt(step.amountRaw);

    if (step.token.isNative) {
      // El gas de los envíos previos ya salió de este saldo: se recorta a lo
      // que queda por encima de la reserva de los pasos pendientes de la red.
      const pendingHere = plan.steps.filter((entry) => entry.sourceNetwork === network && entry.status === 'pending');
      const reserveTxs = pendingHere.flatMap((entry) => (entry.quote?.txs || [{ kind: 'bridge' }]).map((tx) => ({ kind: tx.kind })));
      const reserve = BigInt((await feeOracle.estimateTxCosts({
        network, profile: plan.profile, txs: reserveTxs, nativeUsdPrice: nativePrice,
      })).totalMaxWei || 0);
      const balance = BigInt(await rpc.getBalance(plan.walletAddress));
      const available = balance > reserve ? balance - reserve : 0n;
      if (available <= 0n) {
        throw new AppError(
          `No queda ${step.token.symbol} por encima de la reserva de gas en ${getNetworkConfig(network).label}.`,
          { status: 400, code: 'INSUFFICIENT_NATIVE_FOR_GAS' }
        );
      }
      if (available < amountRaw) amountRaw = available;
    } else {
      // El saldo pudo bajar desde el análisis: un bridge por más del saldo
      // revierte y quema el gas.
      const out = await rpc.call({
        to: step.token.address,
        data: ERC20_BALANCE.encodeFunctionData('balanceOf', [plan.walletAddress]),
      });
      const [tokenBalance] = ERC20_BALANCE.decodeFunctionResult('balanceOf', out);
      if (BigInt(tokenBalance) <= 0n) {
        throw new AppError(
          `No queda ${step.token.symbol} en ${getNetworkConfig(network).label} para este envío.`,
          { status: 400, code: 'INSUFFICIENT_BALANCE' }
        );
      }
      if (BigInt(tokenBalance) < amountRaw) amountRaw = BigInt(tokenBalance);
    }

    const unitPrice = unitPriceFromSnapshot(step);
    const quote = await quoteWithFallback(step, plan, amountRaw);
    const approvals = await dropSatisfiedApprovals(rpc, plan, quote.approvalTxs, amountRaw);
    const txs = bridgeTxsFor({ ...quote, approvalTxs: approvals }, step.token.symbol);
    const gas = await feeOracle.estimateTxCosts({
      network, profile: plan.profile, from: plan.walletAddress, nativeUsdPrice: nativePrice, txs,
    });
    const fees = await feeOracle.getProfileFees({ network, profile: plan.profile });

    const delivery = step.quote?.deliveryToken || {};
    const fromUsd = unitPrice != null ? Number(ethers.formatUnits(amountRaw, step.token.decimals)) * unitPrice : null;
    const toUsd = rawToUsd(quote.toAmountRaw, delivery.decimals ?? 18, delivery.priceUsd ?? null);
    const extraFees = quote.feeCosts.filter((fee) => !fee.included).reduce((acc, fee) => acc + fee.amountUsd, 0);
    const bridgeCostUsd = fromUsd != null && toUsd != null ? Math.max(0, fromUsd - toUsd) + extraFees : extraFees;
    const newCostUsd = round(bridgeCostUsd + (gas.totalExpectedUsd ?? 0));
    const previousCostUsd = step.quote?.shownCostUsd ?? step.estCostUsd;
    const requiresReconfirm = newCostUsd > previousCostUsd * RECONFIRM_RATIO
      && newCostUsd - previousCostUsd > RECONFIRM_MIN_DELTA_USD;

    const chainId = getNetworkConfig(network).chainId;
    const signables = txs.map((tx, index) => signable(tx, { chainId, gasLimit: gas.txs[index].gasLimit, fees }));
    await repo.updateStep(plan.id, step.order, {
      amountRaw: amountRaw.toString(),
      provider: quote.provider,
      estCostUsd: newCostUsd,
      etaSec: quote.etaSec ?? step.etaSec,
      quote: {
        ...step.quote,
        shownCostUsd: previousCostUsd,
        quote,
        txs,
        amountUsd: fromUsd != null ? round(fromUsd) : step.quote?.amountUsd,
        receivedUsd: toUsd != null ? round(toUsd) : step.quote?.receivedUsd,
        costs: { ...(step.quote?.costs || {}), bridgeCostUsd: round(bridgeCostUsd), expectedUsd: newCostUsd },
      },
    });

    return {
      requiresReconfirm,
      previousCostUsd,
      newCostUsd,
      profile: plan.profile,
      amountRaw: amountRaw.toString(),
      txs: signables,
    };
  }

  async function submitStep({ userId, planId, order, kind, txHash, nonce = null, fees = null }) {
    const plan = await loadPlan(userId, planId);
    const step = findStep(plan, order);
    if (kind === 'approval') {
      if (step.status !== 'pending') return step;
      return repo.updateStep(plan.id, step.order, { approvalTxHash: txHash });
    }
    if (step.txHash === txHash) return step;
    // Una tx ya firmada se registra siempre, aunque el plan se haya descartado
    // o su paso se haya saltado mientras tanto: si no, nadie la vigila.
    if (step.status === 'pending' || (step.status === 'skipped' && !step.txHash)) {
      return repo.updateStep(plan.id, step.order, {
        status: 'signed', txHash, nonce, sentFees: fees, signedAt: now(),
      });
    }
    if (step.status === 'signed' && fees?.replacement === true && Number(nonce) === step.nonce) {
      // El original (o un reemplazo anterior) todavía puede ser el que entre.
      const previousTxHashes = [...(step.sentFees?.previousTxHashes || []), step.txHash].filter(Boolean);
      return repo.updateStep(plan.id, step.order, { txHash, sentFees: { ...fees, previousTxHashes } });
    }
    throw new AppError('Este paso ya tiene otra transacción enviada.', { status: 409, code: 'STEP_ALREADY_SUBMITTED' });
  }

  async function skipStep({ userId, planId, order }) {
    const plan = await loadPlan(userId, planId);
    const step = findStep(plan, order);
    if (IN_FLIGHT.has(step.status)) {
      throw new AppError('El envío ya salió: no se puede saltar.', { status: 409, code: 'STEP_IN_FLIGHT' });
    }
    if (step.status === 'pending' || step.status === 'failed' || step.status === 'refunded') {
      await repo.updateStep(plan.id, step.order, { status: 'skipped' });
    }
    await repo.recomputePlanStatus(plan.id);
    return getPlanView({ userId, planId });
  }

  async function continueWithArrived({ userId, planId }) {
    const plan = await loadPlan(userId, planId);
    assertExecuting(plan);
    for (const step of plan.steps) {
      if (step.status === 'pending' || step.status === 'failed' || step.status === 'refunded') {
        await repo.updateStep(plan.id, step.order, { status: 'skipped' });
      }
    }
    await repo.updatePlan(plan.id, { status: 'partial' });
    return getPlanView({ userId, planId });
  }

  async function discardPlan({ userId, planId }) {
    const plan = await loadPlan(userId, planId);
    if (plan.status === 'executing') await repo.updatePlan(plan.id, { status: 'discarded' });
    return getPlanView({ userId, planId });
  }

  function stepView(step) {
    const snapshot = step.quote || {};
    const isSlow = IN_FLIGHT.has(step.status) && step.signedAt != null && step.etaSec != null
      && now() - step.signedAt > step.etaSec * 2_000 + SLOW_GRACE_MS;
    return {
      order: step.order,
      sourceNetwork: step.sourceNetwork,
      token: step.token,
      amountRaw: step.amountRaw,
      amountUsd: snapshot.amountUsd ?? null,
      receivedUsd: snapshot.receivedUsd ?? null,
      deliveryToken: snapshot.deliveryToken || { address: step.deliveryTokenAddress },
      side: snapshot.side || null,
      provider: step.provider,
      carriesDestinationGas: step.carriesDestinationGas,
      status: step.status,
      approvalTxHash: step.approvalTxHash,
      txHash: step.txHash,
      nonce: step.nonce,
      sentProfile: step.sentFees?.profile || null,
      estCostUsd: step.estCostUsd,
      realCostUsd: step.realCostUsd,
      receivedRaw: step.receivedRaw,
      etaSec: step.etaSec,
      signedAt: step.signedAt,
      isSlow,
      errorMessage: step.errorMessage,
      walletOverrodeFees: step.walletOverrodeFees,
      alternative: snapshot.alternative || null,
    };
  }

  function planView(plan) {
    return {
      id: plan.id,
      walletAddress: plan.walletAddress,
      destinationNetwork: plan.destinationNetwork,
      profile: plan.profile,
      thresholdPct: plan.thresholdPct,
      status: plan.status,
      request: plan.request,
      analysis: plan.analysis,
      createdAt: plan.createdAt,
      finishedAt: plan.finishedAt,
      steps: plan.steps.map(stepView),
    };
  }

  async function getPlanView({ userId, planId }) {
    return planView(await loadPlan(userId, planId));
  }

  async function getActivePlan({ userId, walletAddress }) {
    const plan = await repo.findActivePlan(userId, walletAddress);
    return plan ? planView(plan) : null;
  }

  /** Saldos de todas las redes, sin plan: para el panel antes de elegir pool. */
  async function getBalances({ walletAddress }) {
    const multichain = await balances.getMultichainBalances({ walletAddress });
    return { walletAddress, ...multichain };
  }

  return {
    getBalances,
    analyze,
    createPlan,
    toPublicAnalysis,
    prepareStep,
    submitStep,
    skipStep,
    continueWithArrived,
    discardPlan,
    getPlanView,
    getActivePlan,
    planView,
  };
}

module.exports = {
  createCrossChainFundingService,
  toPublicAnalysis,
  LP_TX_KINDS,
  RECONFIRM_RATIO,
  SLOW_GRACE_MS,
};

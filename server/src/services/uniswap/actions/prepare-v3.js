const { ethers } = require('ethers');
const { ValidationError } = require('../../../errors/app-error');
const {
  validatePriceRange,
  validateTickRange,
} = require('../position-validators');
const {
  V3_FACTORY_ABI,
  V3_POOL_ABI,
} = require('../abis');
const {
  DEFAULT_SLIPPAGE_BPS,
  V3_SWAP_ROUTER_ADDRESS,
} = require('../constants');
const {
  encodeTx,
  buildApprovalRequirement,
  maybeBuildApprovalTx,
  appendApprovalIfNeeded,
  buildWrapNativeTx,
  buildUnwrapNativeTx,
} = require('../tx-encoders');
const {
  buildV3IncreaseTx,
  buildV3DecreaseAndCollectTx,
  buildV3CollectAndIncreaseTx,
  buildV3MintTx,
  buildV3SwapTx,
} = require('../tx-builders-v3');
const {
  buildPostPreview,
  buildProtectionImpact,
} = require('../position-presenters');
const {
  priceToNearestTick,
} = require('../position-math');
const uniswapService = require('../../uniswap.service');
const claimFeesService = require('../../uniswap-claim-fees.service');
const smartPoolCreatorService = require('../../smart-pool-creator.service');
const logger = require('../../logger.service');
const onChainManager = require('../../onchain-manager.service');
const {
  buildModifyRangeRedeployPlan,
  buildRebalanceSwap,
  estimateSwapValueUsd,
} = require('../../../domains/uniswap/pools/domain/position-action-math');

const {
  normalizeAddress,
  normalizeCreatePositionPoolOrder,
  getProvider,
  getNetworkConfig,
  getTokenInfo,
  getBalancesAndAllowancesBatch,
  toBigIntAmount,
  buildEstimatedCosts,
  applyCloseBuffer,
  resolveCloseTargetStable,
  getWrappedNativeTokenForNetwork,
  getGasReserveRaw,
  buildClosedPositionPreview,
  appendV3SwapToToken,
  appendFundingSwapTransactions,
  loadV3PositionContext,
  loadV3DecreaseLiquidityContext,
} = require('./helpers');

async function prepareIncreaseLiquidity(payload) {
  const ctx = await loadV3PositionContext(payload);

  // Smart funding: el cliente envia un `totalUsdTarget` (en USD) en lugar
  // de amounts crudos. Reusamos el mismo plan + composicion que ya hace
  // `prepareCreatePosition` (wrap -> swaps -> approvals PM -> increase),
  // pero apuntando a la posicion existente: rango y tokens vienen del
  // ctx, no del payload.
  const usingSmartFunding = payload.totalUsdTarget != null
    || Array.isArray(payload.fundingSelections)
    || Array.isArray(payload.importTokenAddresses);

  if (usingSmartFunding) {
    const rangeLowerPrice = uniswapService.tickToPrice(
      Number(ctx.position.tickLower),
      ctx.token0.decimals,
      ctx.token1.decimals,
    );
    const rangeUpperPrice = uniswapService.tickToPrice(
      Number(ctx.position.tickUpper),
      ctx.token0.decimals,
      ctx.token1.decimals,
    );

    const plan = await smartPoolCreatorService.buildIncreaseLiquidityFundingPlan({
      network: payload.network,
      version: 'v3',
      walletAddress: payload.walletAddress,
      token0Address: ctx.token0.address,
      token1Address: ctx.token1.address,
      fee: Number(ctx.position.fee),
      rangeLowerPrice,
      rangeUpperPrice,
      currentPrice: ctx.priceCurrent,
      totalUsdTarget: Number(payload.totalUsdTarget),
      fundingSelections: payload.fundingSelections,
      importTokenAddresses: payload.importTokenAddresses || [],
      maxSlippageBps: payload.maxSlippageBps ?? payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    });

    const amount0Desired = BigInt(plan.expectedPostSwapBalances.amount0Raw);
    const amount1Desired = BigInt(plan.expectedPostSwapBalances.amount1Raw);

    const txPlan = [];
    const requiresApproval = [];
    const allowanceCache = new Map();

    // Seed cache con allowances ya consultadas para el position manager
    // (ahorra reads cuando el path de swap re-aprovecha la misma allowance).
    const [token0State, token1State] = await getBalancesAndAllowancesBatch({
      provider: ctx.provider,
      networkConfig: ctx.networkConfig,
      tokens: [ctx.token0, ctx.token1],
      walletAddress: ctx.normalizedWallet,
      spender: ctx.positionManagerAddress,
    });
    allowanceCache.set(`${ctx.token0.address}:${ctx.positionManagerAddress}`, { ...token0State });
    allowanceCache.set(`${ctx.token1.address}:${ctx.positionManagerAddress}`, { ...token1State });

    // Combinar wraps nativos (depositos directos + sources de swap) en una
    // sola tx, mismo patron que `prepareCreatePosition`.
    let totalNativeWrapRaw = 0n;
    for (const asset of (plan.selectedFundingAssets || [])) {
      if (asset.isNative && (asset.fundingRole === 'direct_token0' || asset.fundingRole === 'direct_token1')) {
        totalNativeWrapRaw += BigInt(asset.useAmountRaw || 0);
      }
    }
    for (const swap of (plan.swapPlan || [])) {
      if (swap.requiresWrapNative) {
        totalNativeWrapRaw += BigInt(swap.amountInRaw || 0);
      }
    }
    if (totalNativeWrapRaw > 0n) {
      const wrapToken = ctx.token0.address.toLowerCase() === plan.wrappedNativeAddress?.toLowerCase()
        ? ctx.token0
        : ctx.token1.address.toLowerCase() === plan.wrappedNativeAddress?.toLowerCase()
          ? ctx.token1
          : ctx.token0;
      txPlan.push(buildWrapNativeTx(wrapToken, totalNativeWrapRaw, ctx.networkConfig.chainId));
    }

    const swapPlanNoWraps = (plan.swapPlan || []).map((s) => ({ ...s, requiresWrapNative: false }));
    await appendFundingSwapTransactions({
      provider: ctx.provider,
      networkConfig: ctx.networkConfig,
      normalizedWallet: ctx.normalizedWallet,
      swapPlan: swapPlanNoWraps,
      requiresApproval,
      txPlan,
      allowanceCache,
    });

    // Tras los swaps, aprobar el Position Manager si la allowance no
    // alcanza para los amounts post-swap (mismo patron que en
    // `prepareCreatePosition`).
    const token0PmState = allowanceCache.get(`${ctx.token0.address}:${ctx.positionManagerAddress}`) || token0State;
    const token1PmState = allowanceCache.get(`${ctx.token1.address}:${ctx.positionManagerAddress}`) || token1State;
    if (token0PmState.allowance < amount0Desired) {
      requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, amount0Desired));
      txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, amount0Desired, ctx.networkConfig.chainId));
    }
    if (token1PmState.allowance < amount1Desired) {
      requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, amount1Desired));
      txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, amount1Desired, ctx.networkConfig.chainId));
    }

    txPlan.push(buildV3IncreaseTx(ctx, {
      amount0Desired,
      amount1Desired,
      slippageBps: payload.maxSlippageBps ?? payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    }));

    return {
      action: 'increase-liquidity',
      network: ctx.networkConfig.id,
      version: 'v3',
      positionIdentifier: ctx.tokenId,
      walletAddress: ctx.normalizedWallet,
      quoteSummary: {
        token0: ctx.token0,
        token1: ctx.token1,
        amount0Desired: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
        amount1Desired: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
        currentAmounts: ctx.currentAmounts,
        liquidity: ctx.position.liquidity.toString(),
        currentPrice: plan.currentPrice,
        rangeLowerPrice,
        rangeUpperPrice,
        gasReserve: plan.gasReserve,
        fundingPlan: plan.fundingPlan,
        swapCount: plan.swapPlan.length,
      },
      requiresApproval,
      txPlan: txPlan.filter(Boolean),
      fundingPlan: {
        ...plan.fundingPlan,
        gasReserve: plan.gasReserve,
        selectedFundingAssets: plan.selectedFundingAssets,
      },
      swapPlan: plan.swapPlan,
      availableFundingAssets: plan.availableFundingAssets,
      warnings: plan.warnings,
      postActionPositionPreview: buildPostPreview({
        network: ctx.networkConfig.id,
        version: 'v3',
        positionIdentifier: ctx.tokenId,
        tickLower: Number(ctx.position.tickLower),
        tickUpper: Number(ctx.position.tickUpper),
        amount0Desired,
        amount1Desired,
        token0: ctx.token0,
        token1: ctx.token1,
        priceCurrent: ctx.priceCurrent,
      }),
      protectionImpact: buildProtectionImpact(ctx.tokenId),
    };
  }

  // ---------- Path legacy: amounts crudos ----------
  const amount0Desired = toBigIntAmount(payload.amount0Desired, ctx.token0.decimals, 'amount0Desired');
  const amount1Desired = toBigIntAmount(payload.amount1Desired, ctx.token1.decimals, 'amount1Desired');
  const [token0State, token1State] = await getBalancesAndAllowancesBatch({
    provider: ctx.provider,
    networkConfig: ctx.networkConfig,
    tokens: [ctx.token0, ctx.token1],
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
  });

  if (token0State.balance < amount0Desired || token1State.balance < amount1Desired) {
    throw new ValidationError('La wallet no tiene balance suficiente para aumentar liquidez');
  }

  const requiresApproval = [];
  const txPlan = [];
  appendApprovalIfNeeded({
    token: ctx.token0,
    spender: ctx.positionManagerAddress,
    amount: amount0Desired,
    chainId: ctx.networkConfig.chainId,
    currentAllowance: token0State.allowance,
    requiresApproval,
    txPlan,
  });
  appendApprovalIfNeeded({
    token: ctx.token1,
    spender: ctx.positionManagerAddress,
    amount: amount1Desired,
    chainId: ctx.networkConfig.chainId,
    currentAllowance: token1State.allowance,
    requiresApproval,
    txPlan,
  });
  txPlan.push(buildV3IncreaseTx(ctx, { amount0Desired, amount1Desired, slippageBps: payload.slippageBps }));

  return {
    action: 'increase-liquidity',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      amount0Desired: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      currentAmounts: ctx.currentAmounts,
      liquidity: ctx.position.liquidity.toString(),
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      positionIdentifier: ctx.tokenId,
      tickLower: Number(ctx.position.tickLower),
      tickUpper: Number(ctx.position.tickUpper),
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareDecreaseLiquidity(payload) {
  const ctx = await loadV3DecreaseLiquidityContext(payload);
  const percent = Number(payload.liquidityPercent ?? 100);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new ValidationError('liquidityPercent debe estar entre 0 y 100');
  }

  const liquidityDelta = (BigInt(ctx.position.liquidity) * BigInt(Math.round(percent * 100))) / 10_000n;
  if (liquidityDelta <= 0n) {
    throw new ValidationError('La liquidez a retirar es demasiado pequena');
  }

  return {
    action: 'decrease-liquidity',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      liquidityPercent: percent,
      currentLiquidity: ctx.position.liquidity.toString(),
      liquidityDelta: liquidityDelta.toString(),
      receivesDirectlyInWallet: true,
      txCount: 1,
    },
    requiresApproval: [],
    txPlan: [buildV3DecreaseAndCollectTx(ctx, {
      liquidityDelta,
      recipient: ctx.normalizedWallet,
      slippageBps: payload.slippageBps,
    })],
    postActionPositionPreview: {
      network: ctx.networkConfig.id,
      version: 'v3',
      positionIdentifier: ctx.tokenId,
      estimatedRemainingLiquidity: (BigInt(ctx.position.liquidity) - liquidityDelta).toString(),
    },
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareCollectFees(payload) {
  const claim = await claimFeesService.prepareClaimFees(payload);
  return {
    action: 'collect-fees',
    network: claim.claimSummary.network,
    version: claim.claimSummary.version,
    positionIdentifier: String(claim.claimSummary.positionIdentifier),
    walletAddress: claim.claimSummary.recipient,
    quoteSummary: claim.claimSummary,
    requiresApproval: [],
    txPlan: [encodeTx(claim.tx.to, claim.tx.data, {
      value: claim.tx.value,
      chainId: claim.tx.chainId,
      kind: 'collect_fees',
      label: 'Collect fees',
    })],
    postActionPositionPreview: {
      network: claim.claimSummary.network,
      version: claim.claimSummary.version,
      positionIdentifier: String(claim.claimSummary.positionIdentifier),
    },
    protectionImpact: buildProtectionImpact(claim.claimSummary.positionIdentifier),
  };
}

async function prepareReinvestFees(payload) {
  const ctx = await loadV3PositionContext(payload);
  const amount0Desired = BigInt(ctx.position.tokensOwed0);
  const amount1Desired = BigInt(ctx.position.tokensOwed1);
  if (amount0Desired <= 0n && amount1Desired <= 0n) {
    throw new ValidationError('No hay fees pendientes para reinvertir');
  }

  // Approvals first (separate txs), then atomic collect+increase via multicall
  const txPlan = [];
  const requiresApproval = [];
  if (amount0Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, amount0Desired, ctx.networkConfig.chainId));
  }
  if (amount1Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, amount1Desired, ctx.networkConfig.chainId));
  }
  txPlan.push(buildV3CollectAndIncreaseTx(ctx, {
    recipient: ctx.normalizedWallet,
    amount0Desired,
    amount1Desired,
    slippageBps: payload.slippageBps,
  }));

  return {
    action: 'reinvest-fees',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      feesToReinvest: {
        amount0: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      },
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      positionIdentifier: ctx.tokenId,
      tickLower: Number(ctx.position.tickLower),
      tickUpper: Number(ctx.position.tickUpper),
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareModifyRange(payload) {
  const ctx = await loadV3PositionContext(payload);
  const { lowerPrice, upperPrice } = validatePriceRange(payload.rangeLowerPrice, payload.rangeUpperPrice);

  const positionLiquidity = BigInt(ctx.position.liquidity);
  const tokensOwed0 = BigInt(ctx.position.tokensOwed0);
  const tokensOwed1 = BigInt(ctx.position.tokensOwed1);
  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');

  // If position was already emptied (e.g. from a prior failed modify-range), use wallet balances
  const provider = getProvider(ctx.networkConfig);
  let amount0Available, amount1Available;
  if (positionLiquidity === 0n && amount0Current === 0n && amount1Current === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
    const [bal0, bal1] = await getBalancesAndAllowancesBatch({
      provider,
      networkConfig: ctx.networkConfig,
      tokens: [ctx.token0, ctx.token1],
      walletAddress: ctx.normalizedWallet,
      spender: ctx.positionManagerAddress,
    });
    amount0Available = bal0.balance;
    amount1Available = bal1.balance;
    if (amount0Available === 0n && amount1Available === 0n) {
      throw new ValidationError('La posicion no tiene liquidez ni hay tokens en la wallet para crear una nueva.');
    }
  } else {
    amount0Available = amount0Current + tokensOwed0;
    amount1Available = amount1Current + tokensOwed1;
  }

  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  validateTickRange(tickLower, tickUpper);

  const txPlan = [];
  const requiresApproval = [];

  // Combinar decrease+collect en una sola tx via PositionManager.multicall()
  // cuando hay liquidez activa. Si solo hay tokensOwed pendientes (caso de
  // modify-range tras un decrease previo sin collect), llamamos a collect
  // standalone.
  if (positionLiquidity > 0n) {
    txPlan.push(buildV3DecreaseAndCollectTx(ctx, {
      liquidityDelta: positionLiquidity,
      recipient: ctx.normalizedWallet,
      slippageBps: payload.slippageBps,
    }));
  } else if (tokensOwed0 > 0n || tokensOwed1 > 0n) {
    txPlan.push(...(await prepareCollectFees(payload)).txPlan);
  }

  const {
    optimalWeight,
    swap,
    amount0Desired,
    amount1Desired,
  } = buildModifyRangeRedeployPlan(ctx, {
    amount0Available,
    amount1Available,
    lowerPrice,
    upperPrice,
    slippageBps: payload.slippageBps,
  });

  if (swap?.amountIn > 0n) {
    requiresApproval.push(buildApprovalRequirement(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn));
    txPlan.push(maybeBuildApprovalTx(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn, ctx.networkConfig.chainId));
    txPlan.push(buildV3SwapTx(ctx, swap));
  }

  if (amount0Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, amount0Desired, ctx.networkConfig.chainId));
  }
  if (amount1Desired > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, amount1Desired, ctx.networkConfig.chainId));
  }

  txPlan.push(buildV3MintTx(ctx, {
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    slippageBps: payload.slippageBps,
    recipient: ctx.normalizedWallet,
    amount0Min: 0n,
    amount1Min: 0n,
  }));

  const slippageCostUsd = estimateSwapValueUsd(ctx, swap) * (Number(payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000);
  const estimatedCosts = await buildEstimatedCosts(ctx, txPlan, { slippageCostUsd });

  return {
    action: 'modify-range',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      oldRange: {
        tickLower: Number(ctx.position.tickLower),
        tickUpper: Number(ctx.position.tickUpper),
      },
      newRange: {
        tickLower,
        tickUpper,
        rangeLowerPrice: lowerPrice,
        rangeUpperPrice: upperPrice,
      },
      optimalWeightToken0Pct: Number(optimalWeight.toFixed(2)),
      swap: swap ? {
        direction: swap.direction,
        amountIn: ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals),
        tokenIn: swap.tokenIn.symbol,
        tokenOut: swap.tokenOut.symbol,
        minAmountOut: ethers.formatUnits(swap.amountOutMinimum, swap.tokenOut.decimals),
      } : null,
      expectedRedeployAmounts: {
        amount0: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      },
      estimatedCosts,
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId, 'new_position_pending'),
  };
}

async function prepareRebalance(payload) {
  const ctx = await loadV3PositionContext(payload);
  const lowerPrice = Number(payload.rangeLowerPrice || uniswapService.tickToPrice(Number(ctx.position.tickLower), ctx.token0.decimals, ctx.token1.decimals));
  const upperPrice = Number(payload.rangeUpperPrice || uniswapService.tickToPrice(Number(ctx.position.tickUpper), ctx.token0.decimals, ctx.token1.decimals));
  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  const amount0Available = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.position.tokensOwed0);
  const amount1Available = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.position.tokensOwed1);
  const swap = buildRebalanceSwap(ctx, {
    amount0Available,
    amount1Available,
    targetWeightToken0Pct: payload.targetWeightToken0Pct,
    slippageBps: payload.slippageBps,
  });

  // decrease+collect combinado en una sola tx via PositionManager.multicall()
  const txPlan = [
    buildV3DecreaseAndCollectTx(ctx, {
      liquidityDelta: BigInt(ctx.position.liquidity),
      recipient: ctx.normalizedWallet,
      slippageBps: payload.slippageBps,
    }),
  ];
  const requiresApproval = [];

  if (swap?.amountIn > 0n) {
    requiresApproval.push(buildApprovalRequirement(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn));
    txPlan.push(maybeBuildApprovalTx(swap.tokenIn, V3_SWAP_ROUTER_ADDRESS, swap.amountIn, ctx.networkConfig.chainId));
    txPlan.push(buildV3SwapTx(ctx, swap));
  }

  const finalAmount0 = swap?.postAmount0 ?? amount0Available;
  const finalAmount1 = swap?.postAmount1 ?? amount1Available;
  if (finalAmount0 > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token0, ctx.positionManagerAddress, finalAmount0));
    txPlan.push(maybeBuildApprovalTx(ctx.token0, ctx.positionManagerAddress, finalAmount0, ctx.networkConfig.chainId));
  }
  if (finalAmount1 > 0n) {
    requiresApproval.push(buildApprovalRequirement(ctx.token1, ctx.positionManagerAddress, finalAmount1));
    txPlan.push(maybeBuildApprovalTx(ctx.token1, ctx.positionManagerAddress, finalAmount1, ctx.networkConfig.chainId));
  }
  txPlan.push(buildV3MintTx(ctx, {
    tickLower,
    tickUpper,
    amount0Desired: finalAmount0,
    amount1Desired: finalAmount1,
    slippageBps: payload.slippageBps,
    recipient: ctx.normalizedWallet,
  }));

  return {
    action: 'rebalance',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      targetWeightToken0Pct: Number(payload.targetWeightToken0Pct),
      swap: swap ? {
        direction: swap.direction,
        amountIn: ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals),
        tokenIn: swap.tokenIn.symbol,
        tokenOut: swap.tokenOut.symbol,
        minAmountOut: ethers.formatUnits(swap.amountOutMinimum, swap.tokenOut.decimals),
      } : null,
      newRange: {
        tickLower,
        tickUpper,
        rangeLowerPrice: lowerPrice,
        rangeUpperPrice: upperPrice,
      },
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v3',
      tickLower,
      tickUpper,
      amount0Desired: finalAmount0,
      amount1Desired: finalAmount1,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId, 'new_position_pending'),
  };
}

async function prepareCloseKeepAssets(payload) {
  const ctx = await loadV3PositionContext(payload);
  const positionLiquidity = BigInt(ctx.position.liquidity);
  const tokensOwed0 = BigInt(ctx.position.tokensOwed0);
  const tokensOwed1 = BigInt(ctx.position.tokensOwed1);
  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');
  const amount0Expected = amount0Current + tokensOwed0;
  const amount1Expected = amount1Current + tokensOwed1;

  if (positionLiquidity <= 0n && amount0Expected <= 0n && amount1Expected <= 0n) {
    throw new ValidationError('La posicion no tiene liquidez ni fondos pendientes por retirar');
  }

  const txPlan = [];
  // decrease+collect combinado en 1 sola tx via PositionManager.multicall().
  // Si no hay liquidez activa pero quedan tokensOwed (caso "decrease previo
  // sin collect"), seguimos haciendo collect standalone.
  if (positionLiquidity > 0n) {
    txPlan.push(buildV3DecreaseAndCollectTx(ctx, {
      liquidityDelta: positionLiquidity,
      recipient: ctx.normalizedWallet,
      slippageBps: payload.slippageBps,
    }));
  } else if (tokensOwed0 > 0n || tokensOwed1 > 0n) {
    txPlan.push(...(await prepareCollectFees(payload)).txPlan);
  }

  return {
    action: 'close-keep-assets',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      closeMode: 'keep_assets',
      token0: ctx.token0,
      token1: ctx.token1,
      expectedReceipts: {
        amount0: ethers.formatUnits(amount0Expected, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Expected, ctx.token1.decimals),
      },
      receivesDirectlyInWallet: true,
      txCount: txPlan.filter(Boolean).length,
    },
    requiresApproval: [],
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v3', ctx.token0, ctx.token1, {
      expectedWalletReceipts: {
        amount0: ethers.formatUnits(amount0Expected, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Expected, ctx.token1.decimals),
      },
    }),
    protectionImpact: {
      ...buildProtectionImpact(ctx.tokenId),
      willDeactivateProtection: true,
    },
  };
}

async function prepareCloseToUsdc(payload) {
  const ctx = await loadV3PositionContext(payload);
  const usdc = resolveCloseTargetStable(ctx, ctx.networkConfig.id);
  const wrappedNative = getWrappedNativeTokenForNetwork(ctx.networkConfig.id);
  const reserveRaw = getGasReserveRaw(ctx.networkConfig.id);
  const nativeBalanceRaw = await ctx.provider.getBalance(ctx.normalizedWallet).catch(() => 0n);
  const positionLiquidity = BigInt(ctx.position.liquidity);
  const tokensOwed0 = BigInt(ctx.position.tokensOwed0);
  const tokensOwed1 = BigInt(ctx.position.tokensOwed1);
  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');
  const estimatedAmount0 = amount0Current + tokensOwed0;
  const estimatedAmount1 = amount1Current + tokensOwed1;

  if (positionLiquidity <= 0n && estimatedAmount0 <= 0n && estimatedAmount1 <= 0n) {
    throw new ValidationError('La posicion no tiene liquidez ni fondos pendientes por retirar');
  }

  const txPlan = [];
  // decrease+collect combinado en 1 sola tx via PositionManager.multicall().
  if (positionLiquidity > 0n) {
    txPlan.push(buildV3DecreaseAndCollectTx(ctx, {
      liquidityDelta: positionLiquidity,
      recipient: ctx.normalizedWallet,
      slippageBps: payload.slippageBps,
    }));
  } else if (tokensOwed0 > 0n || tokensOwed1 > 0n) {
    txPlan.push(...(await prepareCollectFees(payload)).txPlan);
  }

  const requiresApproval = [];
  const warnings = [];
  const expectedReceipts = [];
  const swapPlan = [];
  let expectedUsdcRaw = 0n;

  let token0SwapAmount = estimatedAmount0;
  let token1SwapAmount = estimatedAmount1;
  const reserveDeficitRaw = nativeBalanceRaw >= reserveRaw ? 0n : reserveRaw - nativeBalanceRaw;
  let unwrapAmountRaw = 0n;
  let unwrapToken = null;

  if (reserveDeficitRaw > 0n) {
    if (wrappedNative && ctx.token0.address.toLowerCase() === wrappedNative.address.toLowerCase() && token0SwapAmount > 0n) {
      unwrapAmountRaw = reserveDeficitRaw > token0SwapAmount ? token0SwapAmount : reserveDeficitRaw;
      token0SwapAmount -= unwrapAmountRaw;
      unwrapToken = ctx.token0;
    } else if (wrappedNative && ctx.token1.address.toLowerCase() === wrappedNative.address.toLowerCase() && token1SwapAmount > 0n) {
      unwrapAmountRaw = reserveDeficitRaw > token1SwapAmount ? token1SwapAmount : reserveDeficitRaw;
      token1SwapAmount -= unwrapAmountRaw;
      unwrapToken = ctx.token1;
    }

    if (unwrapAmountRaw > 0n && unwrapToken) {
      txPlan.push(buildUnwrapNativeTx(unwrapToken, unwrapAmountRaw, ctx.networkConfig.chainId));
    }

    const remainingDeficit = reserveDeficitRaw > unwrapAmountRaw ? reserveDeficitRaw - unwrapAmountRaw : 0n;
    if (remainingDeficit > 0n) {
      throw new ValidationError(`No hay ${ctx.networkConfig.nativeSymbol} suficiente para conservar la reserva de gas requerida.`);
    }
  }

  const assetsToConvert = [
    { token: ctx.token0, estimatedAmount: token0SwapAmount },
    { token: ctx.token1, estimatedAmount: token1SwapAmount },
  ];

  for (const entry of assetsToConvert) {
    if (entry.estimatedAmount <= 0n) continue;
    if (entry.token.address.toLowerCase() === usdc.address.toLowerCase()) {
      expectedUsdcRaw += entry.estimatedAmount;
      expectedReceipts.push({
        symbol: entry.token.symbol,
        amount: ethers.formatUnits(entry.estimatedAmount, entry.token.decimals),
        conversion: 'direct_usdc',
      });
      continue;
    }

    const amountIn = applyCloseBuffer(entry.estimatedAmount);
    const swap = await appendV3SwapToToken({
      provider: ctx.provider,
      networkConfig: ctx.networkConfig,
      normalizedWallet: ctx.normalizedWallet,
      tokenIn: entry.token,
      tokenOut: usdc,
      amountIn,
      slippageBps: payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      txPlan,
      requiresApproval,
    });
    expectedUsdcRaw += swap.amountOutMinimum;
    swapPlan.push({
      tokenIn: entry.token.symbol,
      tokenOut: usdc.symbol,
      amountIn: ethers.formatUnits(amountIn, entry.token.decimals),
      minAmountOut: ethers.formatUnits(swap.amountOutMinimum, usdc.decimals),
      routePoolAddress: swap.routePoolAddress,
    });
    expectedReceipts.push({
      symbol: entry.token.symbol,
      amount: ethers.formatUnits(entry.estimatedAmount, entry.token.decimals),
      conversion: 'swap_to_usdc',
    });
    if (amountIn < entry.estimatedAmount) {
      warnings.push(`Se deja un pequeno remanente de ${entry.token.symbol} para evitar fallos por estimacion.`);
    }
  }

  return {
    action: 'close-to-usdc',
    network: ctx.networkConfig.id,
    version: 'v3',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      closeMode: 'to_usdc',
      targetStableSymbol: usdc.symbol,
      token0: ctx.token0,
      token1: ctx.token1,
      expectedReceipts,
      expectedUsdcOut: ethers.formatUnits(expectedUsdcRaw, usdc.decimals),
      gasReserve: {
        symbol: ctx.networkConfig.nativeSymbol,
        reservedAmount: ethers.formatUnits(reserveRaw, 18),
        nativeBalance: ethers.formatUnits(nativeBalanceRaw, 18),
      },
      unwrapNative: unwrapAmountRaw > 0n ? {
        tokenSymbol: unwrapToken?.symbol || wrappedNative?.symbol || 'WRAPPED_NATIVE',
        amount: ethers.formatUnits(unwrapAmountRaw, unwrapToken?.decimals || 18),
      } : null,
      swapPlan,
      txCount: txPlan.filter(Boolean).length,
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    warnings,
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v3', ctx.token0, ctx.token1, {
      targetStableSymbol: usdc.symbol,
      expectedUsdcOut: ethers.formatUnits(expectedUsdcRaw, usdc.decimals),
      reservedNative: ethers.formatUnits(reserveRaw, 18),
    }),
    protectionImpact: {
      ...buildProtectionImpact(ctx.tokenId),
      willDeactivateProtection: true,
    },
  };
}

async function prepareCreatePosition(payload) {
  const usingSmartFunding = payload.totalUsdTarget != null
    || Array.isArray(payload.fundingSelections)
    || Array.isArray(payload.importTokenAddresses);
  if (usingSmartFunding) {
    const plan = await smartPoolCreatorService.buildFundingPlan({
      network: payload.network,
      version: 'v3',
      walletAddress: payload.walletAddress,
      token0Address: payload.token0Address,
      token1Address: payload.token1Address,
      fee: payload.fee,
      totalUsdTarget: Number(payload.totalUsdTarget),
      targetWeightToken0Pct: Number(payload.targetWeightToken0Pct),
      rangeLowerPrice: Number(payload.rangeLowerPrice),
      rangeUpperPrice: Number(payload.rangeUpperPrice),
      fundingSelections: payload.fundingSelections,
      importTokenAddresses: payload.importTokenAddresses || [],
      maxSlippageBps: payload.maxSlippageBps ?? payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    });
    const networkConfig = getNetworkConfig(payload.network);
    const provider = getProvider(networkConfig);
    const normalizedWallet = normalizeAddress(payload.walletAddress, 'walletAddress');
    const canonicalPlan = normalizeCreatePositionPoolOrder({
      token0: plan.token0,
      token1: plan.token1,
      amount0Desired: BigInt(plan.expectedPostSwapBalances.amount0Raw),
      amount1Desired: BigInt(plan.expectedPostSwapBalances.amount1Raw),
      rangeLowerPrice: payload.rangeLowerPrice,
      rangeUpperPrice: payload.rangeUpperPrice,
      poolToken0Address: plan.poolToken0Address || plan.token0.address,
      poolToken1Address: plan.poolToken1Address || plan.token1.address,
    });
    const token0 = canonicalPlan.token0;
    const token1 = canonicalPlan.token1;
    const amount0Desired = canonicalPlan.amount0Desired;
    const amount1Desired = canonicalPlan.amount1Desired;
    const tickLower = priceToNearestTick(canonicalPlan.rangeLowerPrice, token0.decimals, token1.decimals, Number(plan.tickSpacing), 'down');
    const tickUpper = priceToNearestTick(canonicalPlan.rangeUpperPrice, token0.decimals, token1.decimals, Number(plan.tickSpacing), 'up');
    validateTickRange(tickLower, tickUpper);

    const pmAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
    const [token0State, token1State] = await getBalancesAndAllowancesBatch({
      provider,
      networkConfig,
      tokens: [token0, token1],
      walletAddress: normalizedWallet,
      spender: pmAddress,
    });
    const dummyCtx = {
      networkConfig,
      normalizedWallet,
      positionManagerAddress: pmAddress,
      fee: Number(payload.fee),
      token0,
      token1,
    };
    const txPlan = [];
    const requiresApproval = [];
    const allowanceCache = new Map();

    // Seed cache with already-fetched allowances
    allowanceCache.set(`${token0.address}:${pmAddress}`, { ...token0State });
    allowanceCache.set(`${token1.address}:${pmAddress}`, { ...token1State });

    // Combine ALL native wraps (direct deposits + swap sources) into a single wrap tx
    let totalNativeWrapRaw = 0n;
    for (const asset of (plan.selectedFundingAssets || [])) {
      if (asset.isNative && (asset.fundingRole === 'direct_token0' || asset.fundingRole === 'direct_token1')) {
        totalNativeWrapRaw += BigInt(asset.useAmountRaw || 0);
      }
    }
    for (const swap of (plan.swapPlan || [])) {
      if (swap.requiresWrapNative) {
        totalNativeWrapRaw += BigInt(swap.amountInRaw || 0);
      }
    }
    if (totalNativeWrapRaw > 0n) {
      const wrapToken = token0.address.toLowerCase() === plan.wrappedNativeAddress?.toLowerCase()
        ? token0
        : token1.address.toLowerCase() === plan.wrappedNativeAddress?.toLowerCase()
          ? token1
          : token0;
      txPlan.push(buildWrapNativeTx(wrapToken, totalNativeWrapRaw, networkConfig.chainId));
    }

    // Strip individual wraps from swapPlan since we already wrapped everything above
    const swapPlanNoWraps = (plan.swapPlan || []).map((s) => ({ ...s, requiresWrapNative: false }));
    await appendFundingSwapTransactions({
      provider,
      networkConfig,
      normalizedWallet,
      swapPlan: swapPlanNoWraps,
      requiresApproval,
      txPlan,
      allowanceCache,
    });

    // After swaps, check PM approvals -- but skip if already approved with MaxUint256 for swap router
    // (the swap approval set allowance to MaxUint256 which covers PM too if same token)
    const token0PmKey = `${token0.address}:${pmAddress}`;
    const token1PmKey = `${token1.address}:${pmAddress}`;
    const token0PmState = allowanceCache.get(token0PmKey) || token0State;
    const token1PmState = allowanceCache.get(token1PmKey) || token1State;

    // Need approval if: current on-chain allowance is insufficient AND we didn't already approve
    // via swap router (which wouldn't help PM since it's a different spender)
    const token0NeedsApproval = token0PmState.allowance < amount0Desired;
    const token1NeedsApproval = token1PmState.allowance < amount1Desired;

    if (token0NeedsApproval) {
      requiresApproval.push(buildApprovalRequirement(token0, pmAddress, amount0Desired));
      txPlan.push(maybeBuildApprovalTx(token0, pmAddress, amount0Desired, networkConfig.chainId));
    }
    if (token1NeedsApproval) {
      requiresApproval.push(buildApprovalRequirement(token1, pmAddress, amount1Desired));
      txPlan.push(maybeBuildApprovalTx(token1, pmAddress, amount1Desired, networkConfig.chainId));
    }
    const mintSlippageBps = payload.maxSlippageBps ?? payload.slippageBps;

    // expectedPostSwapBalances now uses amountOutMinimumRaw (guaranteed swap output),
    // so amount0Desired/amount1Desired are conservative -- the wallet will always have
    // at least this much. No additional buffer needed. amount0Min/amount1Min = 0
    // for safety; gas is estimated client-side at signing time using the fresh state
    // after the prior wraps/swaps/approvals are confirmed.
    logger.info('create_position_mint_params', {
      network: networkConfig.id,
      chainId: networkConfig.chainId,
      pmAddress,
      token0: { address: token0.address, symbol: token0.symbol, decimals: token0.decimals },
      token1: { address: token1.address, symbol: token1.symbol, decimals: token1.decimals },
      tickLower,
      tickUpper,
      amount0Desired: amount0Desired.toString(),
      amount1Desired: amount1Desired.toString(),
      amount0DesiredFormatted: ethers.formatUnits(amount0Desired, token0.decimals),
      amount1DesiredFormatted: ethers.formatUnits(amount1Desired, token1.decimals),
      amount0Min: '0',
      amount1Min: '0',
      mintSlippageBps,
      fee: Number(payload.fee),
      recipient: normalizedWallet,
    });
    txPlan.push(buildV3MintTx(dummyCtx, {
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: normalizedWallet,
    }));

    return {
      action: 'create-position',
      network: networkConfig.id,
      version: 'v3',
      positionIdentifier: null,
      walletAddress: normalizedWallet,
      quoteSummary: {
        token0,
        token1,
        fee: Number(payload.fee),
        poolAddress: plan.poolAddress,
        amount0Desired: ethers.formatUnits(amount0Desired, token0.decimals),
        amount1Desired: ethers.formatUnits(amount1Desired, token1.decimals),
        currentPrice: plan.currentPrice,
        rangeLowerPrice: Number(payload.rangeLowerPrice),
        rangeUpperPrice: Number(payload.rangeUpperPrice),
        gasReserve: plan.gasReserve,
        fundingPlan: plan.fundingPlan,
        swapCount: plan.swapPlan.length,
      },
      requiresApproval,
      txPlan: txPlan.filter(Boolean),
      fundingPlan: {
        ...plan.fundingPlan,
        gasReserve: plan.gasReserve,
        selectedFundingAssets: plan.selectedFundingAssets,
      },
      swapPlan: plan.swapPlan,
      warnings: plan.warnings,
      postActionPositionPreview: buildPostPreview({
        network: networkConfig.id,
        version: 'v3',
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        token0,
        token1,
        priceCurrent: plan.currentPrice,
      }),
      protectionImpact: buildProtectionImpact(null, 'new_position_pending'),
    };
  }

  const networkConfig = getNetworkConfig(payload.network);
  const provider = getProvider(networkConfig);
  const normalizedWallet = normalizeAddress(payload.walletAddress, 'walletAddress');
  const token0 = await getTokenInfo(provider, payload.token0Address);
  const token1 = await getTokenInfo(provider, payload.token1Address);
  const fee = Number(payload.fee);
  if (!Number.isInteger(fee) || fee <= 0) {
    throw new ValidationError('fee invalido');
  }

  const factory = onChainManager.getContract({
    runner: provider,
    address: normalizeAddress(networkConfig.deployments.v3.eventSource),
    abi: V3_FACTORY_ABI,
  });
  const poolAddress = await factory.getPool(token0.address, token1.address, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new ValidationError('Solo se soporta crear posicion sobre pools existentes');
  }

  const pool = onChainManager.getContract({ runner: provider, address: poolAddress, abi: V3_POOL_ABI });
  const [tickSpacing, slot0, poolToken0Address, poolToken1Address] = await Promise.all([
    pool.tickSpacing(),
    pool.slot0(),
    pool.token0(),
    pool.token1(),
  ]);
  const canonicalPlan = normalizeCreatePositionPoolOrder({
    token0,
    token1,
    amount0Desired: toBigIntAmount(payload.amount0Desired, token0.decimals, 'amount0Desired'),
    amount1Desired: toBigIntAmount(payload.amount1Desired, token1.decimals, 'amount1Desired'),
    rangeLowerPrice: payload.rangeLowerPrice,
    rangeUpperPrice: payload.rangeUpperPrice,
    poolToken0Address,
    poolToken1Address,
  });
  const canonicalToken0 = canonicalPlan.token0;
  const canonicalToken1 = canonicalPlan.token1;
  const amount0Desired = canonicalPlan.amount0Desired;
  const amount1Desired = canonicalPlan.amount1Desired;
  const pmAddress = normalizeAddress(networkConfig.deployments.v3.positionManager);
  const [token0State, token1State] = await getBalancesAndAllowancesBatch({
    provider,
    networkConfig,
    tokens: [canonicalToken0, canonicalToken1],
    walletAddress: normalizedWallet,
    spender: pmAddress,
  });
  if (token0State.balance < amount0Desired || token1State.balance < amount1Desired) {
    throw new ValidationError('La wallet no tiene balance suficiente para crear la posicion');
  }

  const tickLower = priceToNearestTick(canonicalPlan.rangeLowerPrice, canonicalToken0.decimals, canonicalToken1.decimals, Number(tickSpacing), 'down');
  const tickUpper = priceToNearestTick(canonicalPlan.rangeUpperPrice, canonicalToken0.decimals, canonicalToken1.decimals, Number(tickSpacing), 'up');
  validateTickRange(tickLower, tickUpper);

  const dummyCtx = {
    networkConfig,
    positionManagerAddress: pmAddress,
    fee,
    token0: canonicalToken0,
    token1: canonicalToken1,
  };
  const txPlan = [];
  const requiresApproval = [];
  if (token0State.allowance < amount0Desired) {
    requiresApproval.push(buildApprovalRequirement(canonicalToken0, pmAddress, amount0Desired));
    txPlan.push(maybeBuildApprovalTx(canonicalToken0, pmAddress, amount0Desired, networkConfig.chainId));
  }
  if (token1State.allowance < amount1Desired) {
    requiresApproval.push(buildApprovalRequirement(canonicalToken1, pmAddress, amount1Desired));
    txPlan.push(maybeBuildApprovalTx(canonicalToken1, pmAddress, amount1Desired, networkConfig.chainId));
  }
  txPlan.push(buildV3MintTx(dummyCtx, {
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    slippageBps: payload.slippageBps,
    recipient: normalizedWallet,
  }));

  return {
    action: 'create-position',
    network: networkConfig.id,
    version: 'v3',
    positionIdentifier: null,
    walletAddress: normalizedWallet,
    quoteSummary: {
      token0: canonicalToken0,
      token1: canonicalToken1,
      fee,
      poolAddress: normalizeAddress(poolAddress),
      amount0Desired: ethers.formatUnits(amount0Desired, canonicalToken0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, canonicalToken1.decimals),
      currentPrice: smartPoolCreatorService.orientPriceToSelectedOrder(
        uniswapService.tickToPrice(Number(slot0.tick), canonicalToken0.decimals, canonicalToken1.decimals),
        canonicalPlan.reversed
      ),
      rangeLowerPrice: Number(payload.rangeLowerPrice),
      rangeUpperPrice: Number(payload.rangeUpperPrice),
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: networkConfig.id,
      version: 'v3',
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      token0: canonicalToken0,
      token1: canonicalToken1,
      priceCurrent: uniswapService.tickToPrice(Number(slot0.tick), canonicalToken0.decimals, canonicalToken1.decimals),
    }),
    protectionImpact: buildProtectionImpact(null, 'new_position_pending'),
  };
}

module.exports = {
  prepareIncreaseLiquidity,
  prepareDecreaseLiquidity,
  prepareCollectFees,
  prepareReinvestFees,
  prepareModifyRange,
  prepareRebalance,
  prepareCloseKeepAssets,
  prepareCloseToUsdc,
  prepareCreatePosition,
};

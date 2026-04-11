const { ethers } = require('ethers');
const { ValidationError } = require('../../../errors/app-error');
const {
  validatePriceRange,
  validateTickRange,
} = require('../position-validators');
const {
  MAX_UINT256,
  DEFAULT_SLIPPAGE_BPS,
} = require('../constants');
const {
  buildUnwrapNativeTx,
} = require('../tx-encoders');
const {
  buildV4ModifyTx,
  buildV4RouterTx,
} = require('../tx-builders-v4');
const {
  buildPostPreview,
  buildProtectionImpact,
} = require('../position-presenters');
const {
  priceToNearestTick,
  isZeroAddress,
  estimateLiquidityForAmounts,
} = require('../position-math');
const uniswapService = require('../../uniswap.service');
const smartPoolCreatorService = require('../../smart-pool-creator.service');
const onChainManager = require('../../onchain-manager.service');
const {
  V4_ACTIONS,
  V4_STATE_VIEW_ABI,
  computeV4PoolId,
  encodeV4CloseCurrencyParams,
  encodeV4MintParams,
  encodeV4ModifyLiquidityParams,
  encodeV4SettleAllParams,
  encodeV4SwapExactInSingleParams,
  encodeV4TakeAllParams,
  hasHooks,
  normalizeHooksAddress,
} = require('../../uniswap-v4-helpers.service');
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
  toBigIntAmount,
  buildEstimatedCosts,
  applyCloseBuffer,
  resolveCloseTargetStable,
  getWrappedNativeTokenForNetwork,
  getGasReserveRaw,
  buildClosedPositionPreview,
  appendV3SwapToToken,
  appendPermit2Approvals,
  appendFundingSwapTransactions,
  loadV4PositionContext,
} = require('./helpers');

async function prepareIncreaseLiquidityV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const amount0Desired = toBigIntAmount(payload.amount0Desired, ctx.token0.decimals, 'amount0Desired');
  const amount1Desired = toBigIntAmount(payload.amount1Desired, ctx.token1.decimals, 'amount1Desired');
  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Desired,
    amount1Raw: amount1Desired,
    tickCurrent: ctx.currentTick,
    tickLower: ctx.tickLower,
    tickUpper: ctx.tickUpper,
  });

  const requiresApproval = [];
  const txPlan = [];
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token0,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount0Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token1,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount1Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  txPlan.push(buildV4ModifyTx(ctx, {
    actionCodes: [
      V4_ACTIONS.INCREASE_LIQUIDITY,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4ModifyLiquidityParams({
        tokenId: ctx.tokenId,
        liquidity: liquidityDelta,
        amount0Limit: amount0Desired,
        amount1Limit: amount1Desired,
      }),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
    ],
    label: 'Increase liquidity (v4)',
    kind: 'increase_liquidity_v4',
    meta: {
      v4Actions: ['INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
    },
  }));

  return {
    action: 'increase-liquidity',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      amount0Desired: ethers.formatUnits(amount0Desired, ctx.token0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, ctx.token1.decimals),
      liquidityDelta: liquidityDelta.toString(),
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: ['INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
      positionIdentifier: ctx.tokenId,
      tickLower: ctx.tickLower,
      tickUpper: ctx.tickUpper,
      amount0Desired,
      amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareDecreaseLiquidityV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const percent = Number(payload.liquidityPercent ?? 100);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new ValidationError('liquidityPercent debe estar entre 0 y 100');
  }
  const liquidityDelta = (ctx.positionLiquidity * BigInt(Math.round(percent * 100))) / 10_000n;
  if (liquidityDelta <= 0n) {
    throw new ValidationError('La liquidez a retirar es demasiado pequena');
  }

  return {
    action: 'decrease-liquidity',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      liquidityPercent: percent,
      estimatedCurrentAmounts: ctx.currentAmounts,
      currentLiquidity: ctx.positionLiquidity.toString(),
      liquidityDelta: liquidityDelta.toString(),
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval: [],
    txPlan: [
      buildV4ModifyTx(ctx, {
        actionCodes: [
          V4_ACTIONS.DECREASE_LIQUIDITY,
          V4_ACTIONS.CLOSE_CURRENCY,
          V4_ACTIONS.CLOSE_CURRENCY,
        ],
        params: [
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: liquidityDelta,
            amount0Limit: 0n,
            amount1Limit: 0n,
          }),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
        ],
        label: 'Decrease liquidity (v4)',
        kind: 'decrease_liquidity_v4',
        meta: {
          v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
          poolId: ctx.poolId,
          tickSpacing: ctx.tickSpacing,
          hooks: ctx.poolKey.hooks,
        },
      }),
    ],
    postActionPositionPreview: {
      network: ctx.networkConfig.id,
      version: 'v4',
      positionIdentifier: ctx.tokenId,
      estimatedRemainingLiquidity: (ctx.positionLiquidity - liquidityDelta).toString(),
      poolId: ctx.poolId,
    },
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareReinvestFeesV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const amount0Fees = BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Fees = BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);
  if (amount0Fees <= 0n && amount1Fees <= 0n) {
    throw new ValidationError('No hay fees pendientes para reinvertir');
  }

  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Fees,
    amount1Raw: amount1Fees,
    tickCurrent: ctx.currentTick,
    tickLower: ctx.tickLower,
    tickUpper: ctx.tickUpper,
  });

  return {
    action: 'reinvest-fees',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      feesToReinvest: {
        amount0: ethers.formatUnits(amount0Fees, ctx.token0.decimals),
        amount1: ethers.formatUnits(amount1Fees, ctx.token1.decimals),
      },
      liquidityDelta: liquidityDelta.toString(),
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval: [],
    txPlan: [
      buildV4ModifyTx(ctx, {
        actionCodes: [
          V4_ACTIONS.DECREASE_LIQUIDITY,
          V4_ACTIONS.INCREASE_LIQUIDITY,
          V4_ACTIONS.CLOSE_CURRENCY,
          V4_ACTIONS.CLOSE_CURRENCY,
        ],
        params: [
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: 0n,
            amount0Limit: 0n,
            amount1Limit: 0n,
          }),
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: liquidityDelta,
            amount0Limit: amount0Fees,
            amount1Limit: amount1Fees,
          }),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
        ],
        label: 'Reinvest fees (v4)',
        kind: 'reinvest_fees_v4',
        meta: {
          v4Actions: ['DECREASE_LIQUIDITY', 'INCREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
          poolId: ctx.poolId,
          tickSpacing: ctx.tickSpacing,
          hooks: ctx.poolKey.hooks,
        },
      }),
    ],
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
      positionIdentifier: ctx.tokenId,
      tickLower: ctx.tickLower,
      tickUpper: ctx.tickUpper,
      amount0Desired: amount0Fees,
      amount1Desired: amount1Fees,
      token0: ctx.token0,
      token1: ctx.token1,
      priceCurrent: ctx.priceCurrent,
    }),
    protectionImpact: buildProtectionImpact(ctx.tokenId),
  };
}

async function prepareModifyRangeV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const { lowerPrice, upperPrice } = validatePriceRange(payload.rangeLowerPrice, payload.rangeUpperPrice);

  const amount0Current = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current');
  const amount1Current = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current');
  const amount0Available = amount0Current + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Available = amount1Current + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);
  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  validateTickRange(tickLower, tickUpper);

  const {
    optimalWeight,
    swap,
    amount0Desired: redeployAmount0,
    amount1Desired: redeployAmount1,
  } = buildModifyRangeRedeployPlan(ctx, {
    amount0Available,
    amount1Available,
    lowerPrice,
    upperPrice,
    slippageBps: payload.slippageBps,
  });
  const txPlan = [
    buildV4ModifyTx(ctx, {
      actionCodes: [
        V4_ACTIONS.DECREASE_LIQUIDITY,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4ModifyLiquidityParams({
          tokenId: ctx.tokenId,
          liquidity: ctx.positionLiquidity,
          amount0Limit: 0n,
          amount1Limit: 0n,
        }),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
      ],
      label: 'Withdraw current v4 position',
      kind: 'decrease_liquidity_v4',
      meta: {
        v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: ctx.poolId,
        tickSpacing: ctx.tickSpacing,
        hooks: ctx.poolKey.hooks,
      },
    }),
  ];
  const requiresApproval = [];

  let amount0Desired = redeployAmount0;
  let amount1Desired = redeployAmount1;
  if (swap?.amountIn > 0n) {
    await appendPermit2Approvals({
      provider: ctx.provider,
      token: swap.tokenIn,
      walletAddress: ctx.normalizedWallet,
      spender: ctx.universalRouterAddress,
      amount: swap.amountIn,
      chainId: ctx.networkConfig.chainId,
      requiresApproval,
      txPlan,
    });
    txPlan.push(buildV4RouterTx(ctx, {
      actionCodes: [
        V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
        V4_ACTIONS.SETTLE_ALL,
        V4_ACTIONS.TAKE_ALL,
      ],
      params: [
        encodeV4SwapExactInSingleParams({
          poolKey: ctx.poolKey,
          zeroForOne: swap.direction === 'token0_to_token1',
          amountIn: swap.amountIn,
          amountOutMinimum: swap.amountOutMinimum,
        }),
        encodeV4SettleAllParams(swap.tokenIn.address, MAX_UINT256),
        encodeV4TakeAllParams(swap.tokenOut.address, swap.amountOutMinimum),
      ],
      label: `Swap ${swap.tokenIn.symbol} -> ${swap.tokenOut.symbol} (v4)`,
      kind: 'swap_v4',
      meta: {
        v4Actions: ['SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL'],
        routerAddress: ctx.universalRouterAddress,
        poolId: ctx.poolId,
      },
    }));
  }

  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token0,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount0Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token1,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: amount1Desired,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Desired,
    amount1Raw: amount1Desired,
    tickCurrent: ctx.currentTick,
    tickLower,
    tickUpper,
  });

  txPlan.push(buildV4ModifyTx(ctx, {
    actionCodes: [
      V4_ACTIONS.MINT_POSITION,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4MintParams({
        poolKey: ctx.poolKey,
        tickLower,
        tickUpper,
        liquidity: liquidityDelta,
        amount0Max: amount0Desired,
        amount1Max: amount1Desired,
        owner: ctx.normalizedWallet,
      }),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
    ],
    label: 'Mint rebalanced v4 position',
    kind: 'mint_position_v4',
    meta: {
      v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      createsNewPosition: true,
    },
  }));

  const slippageCostUsd = estimateSwapValueUsd(ctx, swap) * (Number(payload.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10_000);
  const estimatedCosts = await buildEstimatedCosts(ctx, txPlan, { slippageCostUsd });

  return {
    action: 'modify-range',
    network: ctx.networkConfig.id,
    version: 'v4',
    positionIdentifier: ctx.tokenId,
    walletAddress: ctx.normalizedWallet,
    quoteSummary: {
      token0: ctx.token0,
      token1: ctx.token1,
      oldRange: {
        tickLower: ctx.tickLower,
        tickUpper: ctx.tickUpper,
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
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: swap
        ? ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY']
        : ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
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

async function prepareCreatePositionV4(payload) {
  const usingSmartFunding = payload.totalUsdTarget != null
    || Array.isArray(payload.fundingSelections)
    || Array.isArray(payload.importTokenAddresses);
  if (usingSmartFunding) {
    const plan = await smartPoolCreatorService.buildFundingPlan({
      network: payload.network,
      version: 'v4',
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
      tickSpacing: payload.tickSpacing,
      hooks: payload.hooks,
      poolId: payload.poolId,
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
    const canonicalCurrentPrice = canonicalPlan.reversed ? (1 / Number(plan.currentPrice)) : Number(plan.currentPrice);
    const liquidityDelta = estimateLiquidityForAmounts({
      amount0Raw: amount0Desired,
      amount1Raw: amount1Desired,
      tickCurrent: Math.round(Math.log(canonicalCurrentPrice / (10 ** (token0.decimals - token1.decimals))) / Math.log(1.0001)),
      tickLower,
      tickUpper,
    });
    const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
    const requiresApproval = [];
    const txPlan = [];
    await appendFundingSwapTransactions({
      provider,
      networkConfig,
      normalizedWallet,
      swapPlan: plan.swapPlan,
      requiresApproval,
      txPlan,
    });
    await appendPermit2Approvals({
      provider,
      token: token0,
      walletAddress: normalizedWallet,
      spender: positionManagerAddress,
      amount: amount0Desired,
      chainId: networkConfig.chainId,
      requiresApproval,
      txPlan,
      enforceBalance: false,
    });
    await appendPermit2Approvals({
      provider,
      token: token1,
      walletAddress: normalizedWallet,
      spender: positionManagerAddress,
      amount: amount1Desired,
      chainId: networkConfig.chainId,
      requiresApproval,
      txPlan,
      enforceBalance: false,
    });

    const dummyCtx = {
      networkConfig,
      normalizedWallet,
      positionManagerAddress,
      poolKey: {
        currency0: token0.address,
        currency1: token1.address,
        fee: Number(payload.fee),
        tickSpacing: Number(plan.tickSpacing),
        hooks: normalizeHooksAddress(plan.hooks),
      },
      poolId: plan.poolId,
      tickSpacing: Number(plan.tickSpacing),
    };
    txPlan.push(buildV4ModifyTx(dummyCtx, {
      actionCodes: [
        V4_ACTIONS.MINT_POSITION,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4MintParams({
          poolKey: dummyCtx.poolKey,
          tickLower,
          tickUpper,
          liquidity: liquidityDelta,
          amount0Max: amount0Desired,
          amount1Max: amount1Desired,
          owner: normalizedWallet,
        }),
        encodeV4CloseCurrencyParams(dummyCtx.poolKey.currency0),
        encodeV4CloseCurrencyParams(dummyCtx.poolKey.currency1),
      ],
      label: 'Create position (v4)',
      kind: 'create_position_v4',
      meta: {
        v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: plan.poolId,
        tickSpacing: Number(plan.tickSpacing),
        hooks: plan.hooks,
        createsNewPosition: true,
      },
    }));

    return {
      action: 'create-position',
      network: networkConfig.id,
      version: 'v4',
      positionIdentifier: null,
      walletAddress: normalizedWallet,
      quoteSummary: {
        token0,
        token1,
        fee: Number(payload.fee),
        poolId: plan.poolId,
        tickSpacing: Number(plan.tickSpacing),
        hooks: plan.hooks,
        amount0Desired: ethers.formatUnits(amount0Desired, token0.decimals),
        amount1Desired: ethers.formatUnits(amount1Desired, token1.decimals),
        currentPrice: plan.currentPrice,
        rangeLowerPrice: Number(payload.rangeLowerPrice),
        rangeUpperPrice: Number(payload.rangeUpperPrice),
        gasReserve: plan.gasReserve,
        fundingPlan: plan.fundingPlan,
        v4ActionPlan: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
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
        version: 'v4',
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
  const tickSpacing = Number(payload.tickSpacing);
  const hooks = normalizeHooksAddress(payload.hooks);
  if (!Number.isInteger(fee) || fee <= 0) throw new ValidationError('fee invalido');
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new ValidationError('tickSpacing es requerido para crear una posicion v4');
  if (hasHooks(hooks)) throw new ValidationError('Los pools v4 con hooks no estan soportados en gestion on-chain por ahora');

  const orderedPair = smartPoolCreatorService.sortTokensByAddress(token0, token1);
  const canonicalPlan = normalizeCreatePositionPoolOrder({
    token0,
    token1,
    amount0Desired: toBigIntAmount(payload.amount0Desired, token0.decimals, 'amount0Desired'),
    amount1Desired: toBigIntAmount(payload.amount1Desired, token1.decimals, 'amount1Desired'),
    rangeLowerPrice: payload.rangeLowerPrice,
    rangeUpperPrice: payload.rangeUpperPrice,
    poolToken0Address: orderedPair.token0.address,
    poolToken1Address: orderedPair.token1.address,
  });
  const canonicalToken0 = canonicalPlan.token0;
  const canonicalToken1 = canonicalPlan.token1;
  const amount0Desired = canonicalPlan.amount0Desired;
  const amount1Desired = canonicalPlan.amount1Desired;
  const poolKey = {
    currency0: canonicalToken0.address,
    currency1: canonicalToken1.address,
    fee,
    tickSpacing,
    hooks,
  };
  if (isZeroAddress(poolKey.currency0) || isZeroAddress(poolKey.currency1)) {
    throw new ValidationError('Los pools v4 con token nativo no estan soportados en gestion on-chain por ahora');
  }
  const poolId = payload.poolId || computeV4PoolId(poolKey);
  const stateView = onChainManager.getContract({
    runner: provider,
    address: normalizeAddress(networkConfig.deployments.v4.stateView),
    abi: V4_STATE_VIEW_ABI,
  });
  let slot0;
  try {
    slot0 = await stateView.getSlot0(poolId);
  } catch (err) {
    throw new ValidationError(`No se pudo cargar el pool v4: ${err.message}`);
  }
  if (!slot0?.sqrtPriceX96 || BigInt(slot0.sqrtPriceX96) <= 0n) {
    throw new ValidationError('Solo se soporta crear posicion sobre pools v4 existentes');
  }

  const tickLower = priceToNearestTick(canonicalPlan.rangeLowerPrice, canonicalToken0.decimals, canonicalToken1.decimals, tickSpacing, 'down');
  const tickUpper = priceToNearestTick(canonicalPlan.rangeUpperPrice, canonicalToken0.decimals, canonicalToken1.decimals, tickSpacing, 'up');
  validateTickRange(tickLower, tickUpper);
  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: amount0Desired,
    amount1Raw: amount1Desired,
    tickCurrent: Number(slot0.tick),
    tickLower,
    tickUpper,
  });

  const positionManagerAddress = normalizeAddress(networkConfig.deployments.v4.positionManager);
  const requiresApproval = [];
  const txPlan = [];
  await appendPermit2Approvals({
    provider,
    token: canonicalToken0,
    walletAddress: normalizedWallet,
    spender: positionManagerAddress,
    amount: amount0Desired,
    chainId: networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider,
    token: canonicalToken1,
    walletAddress: normalizedWallet,
    spender: positionManagerAddress,
    amount: amount1Desired,
    chainId: networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  const dummyCtx = {
    networkConfig,
    normalizedWallet,
    positionManagerAddress,
    poolKey,
    poolId,
    tickSpacing,
  };
  txPlan.push(buildV4ModifyTx(dummyCtx, {
    actionCodes: [
      V4_ACTIONS.MINT_POSITION,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4MintParams({
        poolKey,
        tickLower,
        tickUpper,
        liquidity: liquidityDelta,
        amount0Max: amount0Desired,
        amount1Max: amount1Desired,
        owner: normalizedWallet,
      }),
      encodeV4CloseCurrencyParams(poolKey.currency0),
      encodeV4CloseCurrencyParams(poolKey.currency1),
    ],
    label: 'Create position (v4)',
    kind: 'create_position_v4',
    meta: {
      v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId,
      tickSpacing,
      hooks,
      createsNewPosition: true,
    },
  }));

  return {
    action: 'create-position',
    network: networkConfig.id,
    version: 'v4',
    positionIdentifier: null,
    walletAddress: normalizedWallet,
    quoteSummary: {
      token0: canonicalToken0,
      token1: canonicalToken1,
      fee,
      poolId,
      tickSpacing,
      hooks,
      amount0Desired: ethers.formatUnits(amount0Desired, canonicalToken0.decimals),
      amount1Desired: ethers.formatUnits(amount1Desired, canonicalToken1.decimals),
      currentPrice: smartPoolCreatorService.orientPriceToSelectedOrder(
        uniswapService.tickToPrice(Number(slot0.tick), canonicalToken0.decimals, canonicalToken1.decimals),
        canonicalPlan.reversed
      ),
      rangeLowerPrice: Number(payload.rangeLowerPrice),
      rangeUpperPrice: Number(payload.rangeUpperPrice),
      v4ActionPlan: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: networkConfig.id,
      version: 'v4',
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

async function prepareRebalanceV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const lowerPrice = Number(payload.rangeLowerPrice || uniswapService.tickToPrice(ctx.tickLower, ctx.token0.decimals, ctx.token1.decimals));
  const upperPrice = Number(payload.rangeUpperPrice || uniswapService.tickToPrice(ctx.tickUpper, ctx.token0.decimals, ctx.token1.decimals));
  const tickLower = priceToNearestTick(lowerPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'down');
  const tickUpper = priceToNearestTick(upperPrice, ctx.token0.decimals, ctx.token1.decimals, ctx.tickSpacing, 'up');
  const amount0Available = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Available = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);
  const swap = buildRebalanceSwap(ctx, {
    amount0Available,
    amount1Available,
    targetWeightToken0Pct: payload.targetWeightToken0Pct,
    slippageBps: payload.slippageBps,
  });

  const txPlan = [
    buildV4ModifyTx(ctx, {
      actionCodes: [
        V4_ACTIONS.DECREASE_LIQUIDITY,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4ModifyLiquidityParams({
          tokenId: ctx.tokenId,
          liquidity: ctx.positionLiquidity,
          amount0Limit: 0n,
          amount1Limit: 0n,
        }),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
      ],
      label: 'Withdraw current v4 position',
      kind: 'decrease_liquidity_v4',
      meta: {
        v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: ctx.poolId,
        tickSpacing: ctx.tickSpacing,
        hooks: ctx.poolKey.hooks,
      },
    }),
  ];
  const requiresApproval = [];

  let finalAmount0 = amount0Available;
  let finalAmount1 = amount1Available;
  if (swap?.amountIn > 0n) {
    await appendPermit2Approvals({
      provider: ctx.provider,
      token: swap.tokenIn,
      walletAddress: ctx.normalizedWallet,
      spender: ctx.universalRouterAddress,
      amount: swap.amountIn,
      chainId: ctx.networkConfig.chainId,
      requiresApproval,
      txPlan,
    });
    txPlan.push(buildV4RouterTx(ctx, {
      actionCodes: [
        V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
        V4_ACTIONS.SETTLE_ALL,
        V4_ACTIONS.TAKE_ALL,
      ],
      params: [
        encodeV4SwapExactInSingleParams({
          poolKey: ctx.poolKey,
          zeroForOne: swap.direction === 'token0_to_token1',
          amountIn: swap.amountIn,
          amountOutMinimum: swap.amountOutMinimum,
        }),
        encodeV4SettleAllParams(swap.tokenIn.address, MAX_UINT256),
        encodeV4TakeAllParams(swap.tokenOut.address, swap.amountOutMinimum),
      ],
      label: `Swap ${swap.tokenIn.symbol} -> ${swap.tokenOut.symbol} (v4)`,
      kind: 'swap_v4',
      meta: {
        v4Actions: ['SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL'],
        routerAddress: ctx.universalRouterAddress,
        poolId: ctx.poolId,
      },
    }));
    finalAmount0 = swap.postAmount0;
    finalAmount1 = swap.postAmount1;
  }

  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token0,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: finalAmount0,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });
  await appendPermit2Approvals({
    provider: ctx.provider,
    token: ctx.token1,
    walletAddress: ctx.normalizedWallet,
    spender: ctx.positionManagerAddress,
    amount: finalAmount1,
    chainId: ctx.networkConfig.chainId,
    requiresApproval,
    txPlan,
  });

  const liquidityDelta = estimateLiquidityForAmounts({
    amount0Raw: finalAmount0,
    amount1Raw: finalAmount1,
    tickCurrent: ctx.currentTick,
    tickLower,
    tickUpper,
  });
  txPlan.push(buildV4ModifyTx(ctx, {
    actionCodes: [
      V4_ACTIONS.MINT_POSITION,
      V4_ACTIONS.CLOSE_CURRENCY,
      V4_ACTIONS.CLOSE_CURRENCY,
    ],
    params: [
      encodeV4MintParams({
        poolKey: ctx.poolKey,
        tickLower,
        tickUpper,
        liquidity: liquidityDelta,
        amount0Max: finalAmount0,
        amount1Max: finalAmount1,
        owner: ctx.normalizedWallet,
      }),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
      encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
    ],
    label: 'Mint rebalanced v4 position',
    kind: 'mint_position_v4',
    meta: {
      v4Actions: ['MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      createsNewPosition: true,
    },
  }));

  return {
    action: 'rebalance',
    network: ctx.networkConfig.id,
    version: 'v4',
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
      poolId: ctx.poolId,
      tickSpacing: ctx.tickSpacing,
      hooks: ctx.poolKey.hooks,
      v4ActionPlan: swap
        ? ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY']
        : ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY', 'MINT_POSITION', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    postActionPositionPreview: buildPostPreview({
      network: ctx.networkConfig.id,
      version: 'v4',
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

async function prepareCloseKeepAssetsV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const amount0Expected = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Expected = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);

  if (ctx.positionLiquidity <= 0n && amount0Expected <= 0n && amount1Expected <= 0n) {
    throw new ValidationError('La posicion no tiene liquidez ni fondos pendientes por retirar');
  }

  return {
    action: 'close-keep-assets',
    network: ctx.networkConfig.id,
    version: 'v4',
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
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval: [],
    txPlan: [
      buildV4ModifyTx(ctx, {
        actionCodes: [
          V4_ACTIONS.DECREASE_LIQUIDITY,
          V4_ACTIONS.CLOSE_CURRENCY,
          V4_ACTIONS.CLOSE_CURRENCY,
        ],
        params: [
          encodeV4ModifyLiquidityParams({
            tokenId: ctx.tokenId,
            liquidity: ctx.positionLiquidity,
            amount0Limit: 0n,
            amount1Limit: 0n,
          }),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
          encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
        ],
        label: 'Close LP and keep assets (v4)',
        kind: 'close_keep_assets_v4',
        meta: {
          v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
          poolId: ctx.poolId,
          tickSpacing: ctx.tickSpacing,
          hooks: ctx.poolKey.hooks,
        },
      }),
    ],
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v4', ctx.token0, ctx.token1, {
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

async function prepareCloseToUsdcV4(payload) {
  const ctx = await loadV4PositionContext(payload);
  const usdc = resolveCloseTargetStable(ctx, ctx.networkConfig.id);
  const wrappedNative = getWrappedNativeTokenForNetwork(ctx.networkConfig.id);
  const reserveRaw = getGasReserveRaw(ctx.networkConfig.id);
  const nativeBalanceRaw = await ctx.provider.getBalance(ctx.normalizedWallet).catch(() => 0n);
  const amount0Expected = toBigIntAmount(ctx.currentAmounts.amount0 || 0, ctx.token0.decimals, 'amount0Current') + BigInt(ctx.unclaimedFeesRaw.fees0 || 0n);
  const amount1Expected = toBigIntAmount(ctx.currentAmounts.amount1 || 0, ctx.token1.decimals, 'amount1Current') + BigInt(ctx.unclaimedFeesRaw.fees1 || 0n);

  if (ctx.positionLiquidity <= 0n && amount0Expected <= 0n && amount1Expected <= 0n) {
    throw new ValidationError('La posicion no tiene liquidez ni fondos pendientes por retirar');
  }

  const txPlan = [
    buildV4ModifyTx(ctx, {
      actionCodes: [
        V4_ACTIONS.DECREASE_LIQUIDITY,
        V4_ACTIONS.CLOSE_CURRENCY,
        V4_ACTIONS.CLOSE_CURRENCY,
      ],
      params: [
        encodeV4ModifyLiquidityParams({
          tokenId: ctx.tokenId,
          liquidity: ctx.positionLiquidity,
          amount0Limit: 0n,
          amount1Limit: 0n,
        }),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency0),
        encodeV4CloseCurrencyParams(ctx.poolKey.currency1),
      ],
      label: 'Withdraw current v4 position',
      kind: 'close_to_usdc_v4_withdraw',
      meta: {
        v4Actions: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
        poolId: ctx.poolId,
        tickSpacing: ctx.tickSpacing,
        hooks: ctx.poolKey.hooks,
      },
    }),
  ];
  const requiresApproval = [];
  const warnings = [];
  const expectedReceipts = [];
  const swapPlan = [];
  let expectedUsdcRaw = 0n;

  let token0SwapAmount = amount0Expected;
  let token1SwapAmount = amount1Expected;
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
    version: 'v4',
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
      v4ActionPlan: ['DECREASE_LIQUIDITY', 'CLOSE_CURRENCY', 'CLOSE_CURRENCY'],
    },
    requiresApproval,
    txPlan: txPlan.filter(Boolean),
    warnings,
    postActionPositionPreview: buildClosedPositionPreview(ctx.networkConfig.id, 'v4', ctx.token0, ctx.token1, {
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

module.exports = {
  prepareIncreaseLiquidityV4,
  prepareDecreaseLiquidityV4,
  prepareReinvestFeesV4,
  prepareModifyRangeV4,
  prepareCreatePositionV4,
  prepareRebalanceV4,
  prepareCloseKeepAssetsV4,
  prepareCloseToUsdcV4,
};

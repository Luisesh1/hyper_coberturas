const { z } = require('zod');

const optionalStringField = z.preprocess((value) => (
  value == null || value === '' ? undefined : value
), z.string().min(1).optional());

const optionalPositiveIntField = z.preprocess((value) => (
  value == null || value === '' ? undefined : value
), z.number().int().positive().optional());

// Refinements compartidos para schemas con token pair + rango de precios
const refineRangeOrder = {
  fn: (data) => data.rangeLowerPrice < data.rangeUpperPrice,
  opts: { message: 'rangeLowerPrice debe ser menor que rangeUpperPrice' },
};
const refineDistinctTokens = {
  fn: (data) => data.token0Address.toLowerCase() !== data.token1Address.toLowerCase(),
  opts: { message: 'token0Address y token1Address deben ser distintos' },
};

const scannedPoolSchema = z.object({
  mode: z.string(),
  version: z.string(),
  network: z.string(),
  identifier: z.union([z.string(), z.number()]),
  owner: z.string().optional(),
  creator: z.string().optional(),
  poolAddress: z.string().nullable().optional(),
  token0Address: z.string().nullable().optional(),
  token1Address: z.string().nullable().optional(),
  rangeLowerPrice: z.number().positive(),
  rangeUpperPrice: z.number().positive(),
  priceCurrent: z.number().positive().nullable().optional(),
  currentValueUsd: z.number().positive(),
  inRange: z.boolean().optional(),
  token0: z.object({
    symbol: z.string().min(1),
  }),
  token1: z.object({
    symbol: z.string().min(1),
  }),
}).passthrough();

const createProtectedPoolSchema = z.object({
  pool: scannedPoolSchema,
  accountId: z.number().int().positive().optional(),
  leverage: z.number().int().positive(),
  configuredNotionalUsd: z.number().positive(),
  stopLossDifferencePct: z.number().positive().lt(100).optional(),
  protectionMode: z.enum(['static', 'dynamic', 'delta_neutral']).optional(),
  reentryBufferPct: z.number().positive().lt(1).optional(),
  flipCooldownSec: z.number().int().min(0).optional(),
  maxSequentialFlips: z.number().int().positive().optional(),
  breakoutConfirmDistancePct: z.number().min(0).lt(100).optional(),
  breakoutConfirmDurationSec: z.number().int().min(0).optional(),
  bandMode: z.enum(['adaptive', 'fixed']).optional(),
  baseRebalancePriceMovePct: z.number().positive().lt(100).optional(),
  rebalanceIntervalSec: z.number().int().min(60).optional(),
  targetHedgeRatio: z.number().positive().max(2).optional(),
  minRebalanceNotionalUsd: z.number().positive().optional(),
  maxSlippageBps: z.number().int().min(1).max(500).optional(),
  twapMinNotionalUsd: z.number().positive().optional(),
  valueMultiplier: z.union([
    z.literal(1.25),
    z.literal(1.5),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.null(),
  ]).optional(),
});

const scanPoolsSchema = z.object({
  wallet: z.string().min(1),
  network: z.string().min(1),
  version: z.string().min(1),
});

const claimFeesPrepareSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  walletAddress: z.string().min(1),
});

const claimFeesFinalizeSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  walletAddress: z.string().min(1),
  txHash: z.string().min(1),
});

const positionActionBaseSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  slippageBps: z.number().int().min(1).max(5000).optional(),
  poolId: optionalStringField,
  tickSpacing: optionalPositiveIntField,
  hooks: optionalStringField,
});

const increaseLiquidityPrepareSchema = positionActionBaseSchema
  .extend({
    positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
    // Path legacy: amounts crudos en unidades del token
    amount0Desired: z.union([z.number().min(0), z.string().min(1)]).optional(),
    amount1Desired: z.union([z.number().min(0), z.string().min(1)]).optional(),
    // Path smart: monto en USD + selección de assets de la wallet
    totalUsdTarget: z.number().positive().optional(),
    maxSlippageBps: z.number().int().positive().max(1000).optional(),
    importTokenAddresses: z.array(z.string().min(1)).optional(),
    fundingSelections: z.array(z.object({
      assetId: z.string().min(1),
      amount: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    })).optional(),
  })
  .refine(
    (d) => d.totalUsdTarget != null || (d.amount0Desired != null && d.amount1Desired != null),
    { message: 'Debes especificar totalUsdTarget o amount0Desired+amount1Desired' },
  );

const increaseLiquidityFundingPlanSchema = positionActionBaseSchema.extend({
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  totalUsdTarget: z.number().positive(),
  maxSlippageBps: z.number().int().positive().max(1000).optional(),
  importTokenAddresses: z.array(z.string().min(1)).optional(),
  fundingSelections: z.array(z.object({
    assetId: z.string().min(1),
    amount: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })).optional(),
});

const decreaseLiquidityPrepareSchema = positionActionBaseSchema.extend({
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  liquidityPercent: z.number().positive().max(100),
});

const collectFeesPrepareSchema = claimFeesPrepareSchema;

const reinvestFeesPrepareSchema = positionActionBaseSchema.extend({
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
});

const modifyRangePrepareSchema = positionActionBaseSchema.extend({
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  rangeLowerPrice: z.number().positive(),
  rangeUpperPrice: z.number().positive(),
});

const rebalancePrepareSchema = positionActionBaseSchema.extend({
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  targetWeightToken0Pct: z.number().gt(0).lt(100),
  rangeLowerPrice: z.number().positive().optional(),
  rangeUpperPrice: z.number().positive().optional(),
});

const createPositionPrepareSchema = positionActionBaseSchema.extend({
  token0Address: z.string().min(1),
  token1Address: z.string().min(1),
  fee: z.number().int().positive(),
  amount0Desired: z.union([z.number().min(0), z.string().min(1)]).optional(),
  amount1Desired: z.union([z.number().min(0), z.string().min(1)]).optional(),
  rangeLowerPrice: z.number().positive(),
  rangeUpperPrice: z.number().positive(),
  totalUsdTarget: z.number().positive().optional(),
  targetWeightToken0Pct: z.number().gt(0).lt(100).optional(),
  maxSlippageBps: z.number().int().positive().max(1000).optional(),
  tickSpacing: optionalPositiveIntField,
  hooks: optionalStringField,
  poolId: optionalStringField,
  importTokenAddresses: z.array(z.string().min(1)).optional(),
  fundingSelections: z.array(z.object({
    assetId: z.string().min(1),
    amount: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })).optional(),
}).refine(refineRangeOrder.fn, refineRangeOrder.opts)
  .refine(refineDistinctTokens.fn, refineDistinctTokens.opts);

const closeToUsdcPrepareSchema = positionActionBaseSchema.extend({
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
});

const closeKeepAssetsPrepareSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  poolId: optionalStringField,
  tickSpacing: optionalPositiveIntField,
  hooks: optionalStringField,
});

const positionActionFinalizeSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  txHashes: z.array(z.string().min(1)).min(1),
});

const smartCreateSuggestSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  token0Address: z.string().min(1),
  token1Address: z.string().min(1),
  fee: z.number().int().positive(),
  totalUsdHint: z.number().positive().optional(),
  totalUsdTarget: z.number().positive().optional(),
  tickSpacing: optionalPositiveIntField,
  hooks: optionalStringField,
  poolId: optionalStringField,
});

const smartCreateFundingPlanSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  token0Address: z.string().min(1),
  token1Address: z.string().min(1),
  fee: z.number().int().positive(),
  totalUsdTarget: z.number().positive(),
  targetWeightToken0Pct: z.number().gt(0).lt(100),
  rangeLowerPrice: z.number().positive(),
  rangeUpperPrice: z.number().positive(),
  maxSlippageBps: z.number().int().positive().max(1000).optional(),
  tickSpacing: optionalPositiveIntField,
  hooks: optionalStringField,
  poolId: optionalStringField,
  importTokenAddresses: z.array(z.string().min(1)).optional(),
  fundingSelections: z.array(z.object({
    assetId: z.string().min(1),
    amount: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })).optional(),
}).refine(refineRangeOrder.fn, refineRangeOrder.opts)
  .refine(refineDistinctTokens.fn, refineDistinctTokens.opts);

module.exports = {
  createProtectedPoolSchema,
  scanPoolsSchema,
  claimFeesPrepareSchema,
  claimFeesFinalizeSchema,
  increaseLiquidityPrepareSchema,
  increaseLiquidityFundingPlanSchema,
  decreaseLiquidityPrepareSchema,
  collectFeesPrepareSchema,
  reinvestFeesPrepareSchema,
  modifyRangePrepareSchema,
  rebalancePrepareSchema,
  createPositionPrepareSchema,
  closeToUsdcPrepareSchema,
  closeKeepAssetsPrepareSchema,
  positionActionFinalizeSchema,
  smartCreateSuggestSchema,
  smartCreateFundingPlanSchema,
};

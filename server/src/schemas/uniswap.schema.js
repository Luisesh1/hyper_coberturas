const { z } = require('zod');

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
});

const increaseLiquidityPrepareSchema = positionActionBaseSchema.extend({
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]),
  amount0Desired: z.union([z.number().min(0), z.string().min(1)]),
  amount1Desired: z.union([z.number().min(0), z.string().min(1)]),
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
  amount0Desired: z.union([z.number().min(0), z.string().min(1)]),
  amount1Desired: z.union([z.number().min(0), z.string().min(1)]),
  rangeLowerPrice: z.number().positive(),
  rangeUpperPrice: z.number().positive(),
});

const positionActionFinalizeSchema = z.object({
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  positionIdentifier: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  txHashes: z.array(z.string().min(1)).min(1),
});

module.exports = {
  createProtectedPoolSchema,
  scanPoolsSchema,
  claimFeesPrepareSchema,
  claimFeesFinalizeSchema,
  increaseLiquidityPrepareSchema,
  decreaseLiquidityPrepareSchema,
  collectFeesPrepareSchema,
  reinvestFeesPrepareSchema,
  modifyRangePrepareSchema,
  rebalancePrepareSchema,
  createPositionPrepareSchema,
  positionActionFinalizeSchema,
};

const { z } = require('zod');

const strategyConfigSchema = z.object({
  rangeWidthPct: z.number().positive().lt(100),
  edgeMarginPct: z.number().min(5).max(49),
  costToRewardThreshold: z.number().positive().lt(1).default(0.3333),
  minRebalanceCooldownSec: z.number().int().min(0).default(3600),
  minNetLpEarningsForRebalanceUsd: z.number().min(0).default(0),
  reinvestThresholdUsd: z.number().min(0).default(0),
  urgentAlertRepeatMinutes: z.number().int().min(1).max(1440).default(30),
  maxSlippageBps: z.number().int().min(1).max(1000).default(100),
});

const protectionConfigSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    accountId: z.number().int().positive(),
    leverage: z.number().int().positive(),
    configuredNotionalUsd: z.number().positive(),
    stopLossDifferencePct: z.number().positive().lt(100).optional(),
    bandMode: z.enum(['adaptive', 'fixed']).optional(),
    baseRebalancePriceMovePct: z.number().positive().lt(100).optional(),
    rebalanceIntervalSec: z.number().int().min(60).optional(),
    targetHedgeRatio: z.number().positive().max(2).optional(),
    minRebalanceNotionalUsd: z.number().positive().optional(),
    maxSlippageBps: z.number().int().min(1).max(500).optional(),
    twapMinNotionalUsd: z.number().positive().optional(),
  }),
]);

const createOrchestratorSchema = z.object({
  name: z.string().min(1).max(255),
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  accountId: z.number().int().positive().optional(),
  token0Address: z.string().min(1),
  token1Address: z.string().min(1),
  token0Symbol: z.string().min(1),
  token1Symbol: z.string().min(1),
  inferredAsset: z.string().min(1).optional(),
  feeTier: z.number().int().positive().optional(),
  initialTotalUsd: z.number().positive(),
  strategyConfig: strategyConfigSchema,
  protectionConfig: protectionConfigSchema.optional(),
});

const finalizeResultSchema = z.object({
  txHashes: z.array(z.string().min(1)).min(1),
  positionChanges: z.object({
    oldPositionIdentifier: z.string().nullable().optional(),
    newPositionIdentifier: z.string().nullable().optional(),
  }).passthrough().optional(),
  refreshedSnapshot: z.any().optional(),
}).passthrough();

const attachLpSchema = z.object({
  finalizeResult: finalizeResultSchema,
  protectionConfig: protectionConfigSchema.optional(),
});

const recordTxFinalizedSchema = z.object({
  action: z.string().min(1),
  finalizeResult: finalizeResultSchema,
  expected: z.object({
    rangeLowerPrice: z.number().positive().optional(),
    rangeUpperPrice: z.number().positive().optional(),
    gasCostUsd: z.number().min(0).optional(),
    slippageCostUsd: z.number().min(0).optional(),
    collectedFeesUsd: z.number().min(0).optional(),
  }).passthrough().optional(),
});

const killLpSchema = z.object({
  mode: z.enum(['auto', 'usdc', 'keep']).default('auto'),
});

// Versión parcial del schema de estrategia para el flujo de edición: el
// cliente puede mandar sólo los campos que cambia. Los `min/max/lt` se
// mantienen para rechazar valores fuera de rango.
const strategyConfigPatchSchema = z.object({
  rangeWidthPct: z.number().positive().lt(100).optional(),
  edgeMarginPct: z.number().min(5).max(49).optional(),
  costToRewardThreshold: z.number().positive().lt(1).optional(),
  minRebalanceCooldownSec: z.number().int().min(0).optional(),
  minNetLpEarningsForRebalanceUsd: z.number().min(0).optional(),
  reinvestThresholdUsd: z.number().min(0).optional(),
  urgentAlertRepeatMinutes: z.number().int().min(1).max(1440).optional(),
  maxSlippageBps: z.number().int().min(1).max(1000).optional(),
});

const updateOrchestratorConfigSchema = z.object({
  strategyConfig: strategyConfigPatchSchema.optional(),
  // La protección se reemplaza completa si viene (schema union enabled/disabled),
  // porque mezclar `enabled: true` con `enabled: false` no tiene sentido parcial.
  protectionConfig: protectionConfigSchema.optional(),
}).refine((value) => value.strategyConfig || value.protectionConfig, {
  message: 'Debe enviarse strategyConfig o protectionConfig',
});

module.exports = {
  strategyConfigSchema,
  strategyConfigPatchSchema,
  protectionConfigSchema,
  createOrchestratorSchema,
  updateOrchestratorConfigSchema,
  attachLpSchema,
  recordTxFinalizedSchema,
  killLpSchema,
};

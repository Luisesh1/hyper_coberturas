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
  // Rango adaptativo (advisory): k·RV para el ancho base + cotas. Ver
  // lp-orchestrator/range-recommender.js.
  rangeVolMultiplier: z.number().positive().max(2).default(0.15),
  minRangeWidthPct: z.number().positive().lt(100).default(1),
  maxRangeWidthPct: z.number().positive().lt(100).default(30),
  // --- Identidad del pool v4 (ignorada en v3) ---
  // Un pool v4 se identifica por poolId = keccak(currency0, currency1, fee,
  // tickSpacing, hooks). El poolId se computa y el tickSpacing se deriva del
  // feeTier, asi que solo hace falta declararlo si el pool usa uno no
  // estandar. NO hay campo de hooks: `loadV4PositionContext` rechaza todo
  // pool con hook, de modo que una posicion asi no seria gestionable.
  // Vive aca (y no en una columna nueva) porque strategy_config_json ya
  // persiste con el orquestador y sobrevive a los kill+recreate.
  v4TickSpacing: z.number().int().positive().max(32767).optional(),
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
  rangeVolMultiplier: z.number().positive().max(2).optional(),
  minRangeWidthPct: z.number().positive().lt(100).optional(),
  maxRangeWidthPct: z.number().positive().lt(100).optional(),
});

const updateOrchestratorConfigSchema = z.object({
  strategyConfig: strategyConfigPatchSchema.optional(),
  // La protección se reemplaza completa si viene (schema union enabled/disabled),
  // porque mezclar `enabled: true` con `enabled: false` no tiene sentido parcial.
  protectionConfig: protectionConfigSchema.optional(),
}).refine((value) => value.strategyConfig || value.protectionConfig, {
  message: 'Debe enviarse strategyConfig o protectionConfig',
});

// ── Wizard unificado ───────────────────────────────────────────────────────
// El plan es lo que el wizard tiene en la mano antes de firmar: pool, rango,
// capital y cobertura. `strategyConfig` no viaja completo porque el ancho de
// rango se deriva del rango elegido (ver create-saga.buildOrchestratorPayload).

const wizardProtectionSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    accountId: z.number().int().positive(),
    leverage: z.number().int().positive(),
    configuredNotionalUsd: z.number().positive().nullable().optional(),
    bandMode: z.enum(['adaptive', 'fixed']).optional(),
    baseRebalancePriceMovePct: z.number().positive().lt(100).optional(),
    rebalanceIntervalSec: z.number().int().min(60).optional(),
    targetHedgeRatio: z.number().positive().max(2).optional(),
    minRebalanceNotionalUsd: z.number().positive().optional(),
    maxSlippageBps: z.number().int().min(1).max(500).optional(),
    twapMinNotionalUsd: z.number().positive().optional(),
  }),
]);

// La estrategia que manda el wizard NO es strategyConfigPatchSchema: lleva
// dos campos propios que aquel descartaría en silencio (zod strippea las
// claves desconocidas), dejando el desacople del rango sin efecto y el
// tickSpacing de v4 perdido.
const wizardStrategySchema = strategyConfigPatchSchema.extend({
  // El usuario desacopló el ancho de rebalanceo del rango inicial.
  rangeWidthDecoupled: z.boolean().optional(),
  // Solo v4: se persiste cuando el pool declara un tickSpacing distinto del
  // que el backend derivaría del fee tier.
  v4TickSpacing: z.number().int().positive().max(32767).optional(),
});

const lpPlanSchema = z.object({
  mode: z.enum(['standalone', 'orchestrated']).default('orchestrated'),
  name: z.string().min(1).max(255),
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  walletAddress: z.string().min(1),
  token0Address: z.string().min(1),
  token1Address: z.string().min(1),
  token0Symbol: z.string().min(1),
  token1Symbol: z.string().min(1),
  feeTier: z.number().int().positive().optional(),
  capitalUsd: z.number().positive(),
  rangeLowerPrice: z.number().positive(),
  rangeUpperPrice: z.number().positive(),
  priceCurrent: z.number().positive(),
  strategy: wizardStrategySchema.optional(),
  protection: wizardProtectionSchema,
});

// El pre-flight corre antes de que exista el rango definitivo, así que pide
// menos que el plan completo: solo lo que condiciona la cobertura.
const preflightProtectionSchema = z.object({
  token0Symbol: z.string().min(1),
  token1Symbol: z.string().min(1),
  capitalUsd: z.number().positive(),
  protection: wizardProtectionSchema,
});

const createIntentSchema = z.object({
  plan: lpPlanSchema,
});

const commitIntentSchema = z.object({
  operationKey: z.string().min(1),
  finalizeResult: z.object({}).passthrough(),
});

module.exports = {
  strategyConfigSchema,
  wizardStrategySchema,
  lpPlanSchema,
  preflightProtectionSchema,
  createIntentSchema,
  commitIntentSchema,
  strategyConfigPatchSchema,
  protectionConfigSchema,
  createOrchestratorSchema,
  updateOrchestratorConfigSchema,
  attachLpSchema,
  recordTxFinalizedSchema,
  killLpSchema,
};

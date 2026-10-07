const { z } = require('zod');

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'dirección inválida');
const token = z.object({
  address,
  symbol: z.string().min(1).max(20),
  decimals: z.number().int().min(0).max(36),
});
const profile = z.enum(['low', 'medium', 'high']);
const sourceIds = z.array(z.string().min(1).max(120)).max(100).optional();

const fundingAnalysisSchema = z.object({
  walletAddress: address,
  network: z.string().min(1),
  version: z.enum(['v3', 'v4']),
  token0: token,
  token1: token,
  totalUsdTarget: z.number().positive(),
  targetWeightToken0Pct: z.number().gt(0).lt(100),
  profile: profile.optional(),
  thresholdPct: z.number().positive().max(50).optional(),
  maxSlippageBps: z.number().int().positive().max(1000).optional(),
  forcedSources: sourceIds,
  disabledSources: sourceIds,
  // Lo que el asistente necesita para reabrirse en este pool al reanudar.
  wizardContext: z.object({
    fee: z.number().int().nonnegative().optional(),
    tickSpacing: z.number().int().positive().nullable().optional(),
    hooks: z.string().nullable().optional(),
    poolId: z.string().nullable().optional(),
    token0Address: z.string().optional(),
    token1Address: z.string().optional(),
  }).optional(),
});

const prepareStepSchema = z.object({
  speedUp: z.boolean().optional(),
});

const uintString = z.string().regex(/^\d+$/);
const submitStepSchema = z.object({
  kind: z.enum(['approval', 'bridge']),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'hash inválido'),
  nonce: z.number().int().nonnegative().nullable().optional(),
  fees: z.object({
    profile,
    maxFeePerGas: uintString,
    maxPriorityFeePerGas: uintString,
    gasLimit: uintString.optional(),
    replacement: z.boolean().optional(),
  }).nullable().optional(),
});

const walletQuerySchema = z.object({ walletAddress: address });

module.exports = { fundingAnalysisSchema, prepareStepSchema, submitStepSchema, walletQuerySchema };

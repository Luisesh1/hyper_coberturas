const { z } = require('zod');

// Validación de forma; los rangos de cada parámetro los valida el template.
const params = z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional();
const limitValue = z.union([z.number().nonnegative(), z.null()]).optional();
const limits = z.object({
  maxMarginUsdt: limitValue,
  maxDailyLossUsdt: limitValue,
  maxNetDelta: limitValue,
  maxOrdersPerDay: limitValue,
}).optional();
const underlying = z.string().min(1).max(20);
const time = z.union([z.number().int().nonnegative(), z.string().min(1).max(40)]).optional();

const createStrategySchema = z.object({
  name: z.string().max(120).optional(),
  template: z.string().min(1).max(40),
  underlying,
  params,
  limits,
  mode: z.enum(['paused', 'shadow', 'live']).optional(),
});

const updateStrategySchema = z.object({
  name: z.string().max(120).optional(),
  underlying: underlying.optional(),
  params,
  limits,
});

const strategyModeSchema = z.object({
  mode: z.enum(['paused', 'shadow', 'live']),
  confirm: z.boolean().optional(),
});

const createBacktestSchema = z.object({
  strategyId: z.number().int().positive().optional(),
  template: z.string().min(1).max(40).optional(),
  params,
  underlying: underlying.optional(),
  from: time,
  to: time,
  capitalUsdt: z.number().positive().optional(),
  source: z.enum(['recorded', 'dvol', 'realized']).optional(),
  spreadPct: z.number().min(0).max(100).optional(),
  feePct: z.number().min(0).max(5).optional(),
  volPremiumPct: z.number().min(-90).max(500).optional(),
}).refine((v) => v.strategyId != null || v.template, { message: 'Indica strategyId o template', path: ['template'] });

// Bots por alertas: los rangos de params los valida el template `alert_signal`.
const alertIds = z.array(z.number().int().positive()).min(1).max(50);
const autoBotParams = z.record(
  z.string(),
  z.union([
    z.number(), z.string(), z.null(), z.array(z.number().int().positive()),
    // `notify`: el template valida que sean dos booleanos.
    z.record(z.string(), z.boolean()),
  ])
).optional();

const createAutoBotSchema = z.object({
  name: z.string().trim().min(1).max(120),
  underlying,
  alertIds,
  params: autoBotParams,
  limits,
});

const updateAutoBotSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  alertIds: alertIds.optional(),
  params: autoBotParams,
  limits,
});

// La falta de confirm la responde antes la ruta con CONFIRM_REQUIRED.
const closeAutoBotSchema = z.object({
  positionIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
  confirm: z.literal(true),
});

const simulateAutoBotSchema = z.object({
  direction: z.enum(['bullish', 'bearish']),
});

module.exports = {
  simulateAutoBotSchema,
  createAutoBotSchema,
  closeAutoBotSchema,
  updateAutoBotSchema,
  createStrategySchema,
  updateStrategySchema,
  strategyModeSchema,
  createBacktestSchema,
};

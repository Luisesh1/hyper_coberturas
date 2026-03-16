const { z } = require('zod');

const createHedgeSchema = z.object({
  asset: z.string().min(1).max(20),
  entryPrice: z.number().positive(),
  exitPrice: z.number().positive(),
  size: z.number().positive(),
  leverage: z.number().int().min(1).max(100),
  label: z.string().max(255).optional(),
  direction: z.enum(['short', 'long']).optional(),
  accountId: z.number().int().positive().optional(),
});

module.exports = { createHedgeSchema };

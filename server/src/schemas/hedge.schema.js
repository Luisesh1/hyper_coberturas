const { z } = require('zod');

const createHedgeSchema = z.object({
  asset: z.string().min(1).max(20),
  entryPrice: z.coerce.number().positive(),
  exitPrice: z.coerce.number().positive(),
  size: z.coerce.number().positive(),
  leverage: z.coerce.number().int().min(1).max(100),
  label: z.string().max(255).optional(),
  direction: z.enum(['short', 'long']).optional(),
  accountId: z.coerce.number().int().positive().optional(),
});

module.exports = { createHedgeSchema };

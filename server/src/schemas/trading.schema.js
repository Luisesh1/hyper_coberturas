const { z } = require('zod');

const openPositionSchema = z.object({
  asset: z.string().min(1),
  side: z.enum(['long', 'short']),
  size: z.coerce.number().positive(),
  leverage: z.coerce.number().int().positive().optional(),
  marginMode: z.enum(['cross', 'isolated']).optional(),
  limitPrice: z.coerce.number().positive().optional(),
  accountId: z.coerce.number().int().positive().optional(),
});

const closePositionSchema = z.object({
  asset: z.string().min(1),
  size: z.coerce.number().positive().optional(),
  accountId: z.coerce.number().int().positive().optional(),
});

const setSltpSchema = z.object({
  asset: z.string().min(1),
  side: z.enum(['long', 'short']),
  size: z.coerce.number().positive(),
  slPrice: z.coerce.number().positive().optional(),
  tpPrice: z.coerce.number().positive().optional(),
  accountId: z.coerce.number().int().positive().optional(),
});

module.exports = { openPositionSchema, closePositionSchema, setSltpSchema };

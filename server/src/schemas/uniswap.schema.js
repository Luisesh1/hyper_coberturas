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
  stopLossDifferencePct: z.number().positive().lt(1).optional(),
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

module.exports = {
  createProtectedPoolSchema,
  scanPoolsSchema,
};

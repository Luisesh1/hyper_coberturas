const { z } = require('zod');

const MAX_BATCH_ENTRIES = 50;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_STACK_LENGTH = 8_000;

const clientLogEntrySchema = z.object({
  level: z.enum(['warn', 'error']),
  source: z.string().min(1).max(64),
  message: z.string().max(MAX_MESSAGE_LENGTH),
  ts: z.string().datetime().optional(),
  stack: z.string().max(MAX_STACK_LENGTH).optional().nullable(),
  // Campos contextuales libres (filename, lineno, requestId, status, etc.)
}).passthrough();

const clientLogsBatchSchema = z.object({
  entries: z.array(clientLogEntrySchema).min(1).max(MAX_BATCH_ENTRIES),
});

module.exports = {
  clientLogEntrySchema,
  clientLogsBatchSchema,
  MAX_BATCH_ENTRIES,
  MAX_MESSAGE_LENGTH,
  MAX_STACK_LENGTH,
};

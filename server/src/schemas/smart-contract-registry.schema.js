const { z } = require('zod');

const contractType = z.enum(['uniswap_v4_dynamic_fee_hook']);
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hash = z.string().min(3).max(128);

const createContractSchema = z.object({
  name: z.string().min(1).max(255),
  contractType,
  description: z.string().max(10_000).optional(),
});

const createVersionSchema = z.object({
  version: z.string().min(1).max(64),
  sourceCode: z.string().min(1).max(2_000_000),
  sourceHash: hash,
  compilerVersion: z.string().max(80).optional(),
  abi: z.array(z.unknown()).optional(),
  artifactBytecodeHash: hash.optional(),
});

const recordDeploymentSchema = z.object({
  network: z.string().min(1).max(80),
  address,
  txHash: hash,
  artifactBytecodeHash: hash.optional(),
});

const verifyVersionSchema = z.object({
  network: z.string().min(1).max(80),
});

// Redes que cubre el catalogo de contratos desplegables del proyecto.
const SUPPORTED_CATALOG_NETWORKS = ['ethereum', 'arbitrum', 'base', 'base-sepolia', 'optimism', 'polygon'];

const catalogNetworkSchema = z.object({
  network: z.enum(SUPPORTED_CATALOG_NETWORKS),
});

const adoptSchema = z.object({
  network: z.enum(SUPPORTED_CATALOG_NETWORKS),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'txHash invalido').optional(),
});

module.exports = {
  createContractSchema,
  createVersionSchema,
  recordDeploymentSchema,
  verifyVersionSchema,
  catalogNetworkSchema,
  adoptSchema,
  SUPPORTED_CATALOG_NETWORKS,
};

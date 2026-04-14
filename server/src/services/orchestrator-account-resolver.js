/**
 * orchestrator-account-resolver.js
 *
 * Resuelve el `hyperliquid_account_id` efectivo de un orquestador.
 *
 * Un orquestador puede tener el account_id en 2 lugares:
 *   1. lp_orchestrators.hyperliquid_account_id  (directo)
 *   2. protected_uniswap_pools.hyperliquid_account_id  (via active_protected_pool_id)
 *
 * Si un orquestador gestiona su hedge unicamente a traves de un protected_pool,
 * el campo directo queda NULL. Varios servicios asumian el campo directo y
 * reportaban balance 0 — este helper centraliza la resolucion.
 *
 * Devuelve `{ accountId, source }` donde source es uno de:
 *   - 'orchestrator'  — lp_orchestrators.hyperliquid_account_id
 *   - 'protected_pool' — protected_uniswap_pools.hyperliquid_account_id
 *   - null            — ningun hedge vinculado
 */

const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const logger = require('./logger.service');

async function resolveOrchestratorAccountId(orchestrator, { repository = protectedPoolRepository } = {}) {
  if (!orchestrator) return { accountId: null, source: null };

  if (orchestrator.accountId != null) {
    return { accountId: orchestrator.accountId, source: 'orchestrator' };
  }

  if (orchestrator.activeProtectedPoolId == null) {
    return { accountId: null, source: null };
  }

  try {
    const pool = await repository.getById(
      orchestrator.userId,
      orchestrator.activeProtectedPoolId
    );
    if (pool?.accountId != null) {
      return { accountId: pool.accountId, source: 'protected_pool' };
    }
  } catch (err) {
    logger.warn('orchestrator_account_resolve_failed', {
      orchestratorId: orchestrator.id,
      protectedPoolId: orchestrator.activeProtectedPoolId,
      error: err.message,
    });
  }

  return { accountId: null, source: null };
}

module.exports = {
  resolveOrchestratorAccountId,
};

const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const logger = require('./logger.service');
const operationRepo = require('../repositories/uniswap-operation.repository');
const positionActionsService = require('./uniswap-position-actions.service');
const claimFeesService = require('./uniswap-claim-fees.service');
const { AppError, NotFoundError } = require('../errors/app-error');
const { CLOSE_ACTIONS } = require('./uniswap/constants');

function buildOperationKey({ kind, userId, action, txHashes }) {
  const sortedHashes = [...new Set((txHashes || []).filter(Boolean).map((item) => String(item).toLowerCase()))].sort();
  const raw = [kind, userId, action, ...sortedHashes].join(':');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function buildOperationEnvelope(operation) {
  if (!operation) return null;
  return {
    operationId: operation.id,
    kind: operation.kind,
    action: operation.action,
    network: operation.network,
    version: operation.version,
    walletAddress: operation.walletAddress,
    positionIdentifier: operation.positionIdentifier,
    txHashes: operation.txHashes,
    status: operation.status,
    step: operation.step,
    result: operation.result,
    error: operation.errorCode || operation.errorMessage
      ? {
        code: operation.errorCode || 'UNISWAP_OPERATION_FAILED',
        message: operation.errorMessage || 'La operación falló',
      }
      : null,
    replacementMap: operation.replacementMap || {},
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    finishedAt: operation.finishedAt,
  };
}

class UniswapOperationService {
  constructor(deps = {}) {
    this.intervalMs = deps.intervalMs || config.intervals.uniswapOperationPollMs;
    this.logger = deps.logger || logger;
    this.operationRepo = deps.operationRepo || operationRepo;
    this.positionActionsService = deps.positionActionsService || positionActionsService;
    this.claimFeesService = deps.claimFeesService || claimFeesService;
    this.interval = null;
    this.running = false;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.processPending().catch((err) => {
        this.logger.error('uniswap_operation_worker_unhandled_error', { error: err.message });
      });
    }, this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async submitPositionActionFinalize({
    userId,
    action,
    network,
    version,
    walletAddress,
    positionIdentifier,
    txHashes,
  }) {
    const operation = await this.operationRepo.createOrReuse({
      userId,
      operationKey: buildOperationKey({
        kind: 'position_action',
        userId,
        action,
        txHashes,
      }),
      kind: 'position_action',
      action,
      network,
      version,
      walletAddress,
      positionIdentifier: positionIdentifier != null ? String(positionIdentifier) : null,
      txHashes: txHashes.map(String),
      status: 'queued',
      step: 'queued',
    });
    this._kick();
    return buildOperationEnvelope(operation);
  }

  async submitClaimFeesFinalize({
    userId,
    network,
    version,
    walletAddress,
    positionIdentifier,
    txHash,
  }) {
    const operation = await this.operationRepo.createOrReuse({
      userId,
      operationKey: buildOperationKey({
        kind: 'claim_fees',
        userId,
        action: 'claim-fees',
        txHashes: [txHash],
      }),
      kind: 'claim_fees',
      action: 'claim-fees',
      network,
      version,
      walletAddress,
      positionIdentifier: String(positionIdentifier),
      txHashes: [String(txHash)],
      status: 'queued',
      step: 'queued',
    });
    this._kick();
    return buildOperationEnvelope(operation);
  }

  async getOperation(userId, operationId) {
    const operation = await this.operationRepo.getById(userId, operationId);
    if (!operation) {
      throw new NotFoundError('Operacion no encontrada');
    }
    return buildOperationEnvelope(operation);
  }

  async processPending() {
    if (this.running) return;
    this.running = true;
    try {
      // Reserva atómicamente las operaciones pendientes con FOR UPDATE SKIP LOCKED
      // marcándolas `processing` dentro de la misma tx. Otros workers
      // concurrentes no volverán a verlas hasta que terminemos o liberemos.
      const operations = await db.transaction(async (client) => {
        const claimed = await this.operationRepo.claimPending(20, client);
        if (claimed.length === 0) return [];
        const now = Date.now();
        for (const op of claimed) {
          await this.operationRepo.updateState(op.id, { step: op.step || op.status, updatedAt: now }, client);
        }
        return claimed;
      });

      for (const operation of operations) {
        await this.processOne(operation).catch((err) => {
          this.logger.error('uniswap_operation_process_failed', {
            operationId: operation.id,
            kind: operation.kind,
            action: operation.action,
            error: err.message,
          });
        });
      }
    } finally {
      this.running = false;
    }
  }

  async processOne(operation) {
    if (!operation) return null;
    if (operation.kind === 'claim_fees') {
      return this._processClaimFees(operation);
    }
    return this._processPositionAction(operation);
  }

  _kick() {
    setTimeout(() => {
      this.processPending().catch((err) => {
        this.logger.warn('uniswap_operation_kick_failed', { error: err.message });
      });
    }, 10);
  }

  async _processPositionAction(operation) {
    const replacementMap = operation.replacementMap || {};
    let receipts;
    try {
      const collected = await this.positionActionsService.collectFinalizeReceipts({
        action: operation.action,
        network: operation.network,
        version: operation.version,
        walletAddress: operation.walletAddress,
        txHashes: operation.txHashes,
        onProgress: (step) => {
          void this.operationRepo.updateState(operation.id, { status: step, step, replacementMap });
        },
      });
      receipts = collected.receipts;
    } catch (err) {
      await this._markFailed(operation.id, err);
      return null;
    }

    try {
      const result = await this.positionActionsService.finalizePositionActionAfterReceipts({
        userId: operation.userId,
        action: operation.action,
        network: operation.network,
        version: operation.version,
        walletAddress: operation.walletAddress,
        positionIdentifier: operation.positionIdentifier,
        txHashes: operation.txHashes,
        receipts,
        onProgress: (step) => {
          void this.operationRepo.updateState(operation.id, { status: step, step, replacementMap });
        },
      });
      const isClose = CLOSE_ACTIONS.has(operation.action);
      const nextStatus = !isClose && result?.refreshedSnapshot === null && operation.positionIdentifier
        ? 'needs_reconcile'
        : 'done';
      const updated = await this.operationRepo.updateState(operation.id, {
        status: nextStatus,
        step: nextStatus,
        result,
        replacementMap,
        finishedAt: Date.now(),
      });
      return buildOperationEnvelope(updated);
    } catch (err) {
      const updated = await this.operationRepo.updateState(operation.id, {
        status: 'needs_reconcile',
        step: 'needs_reconcile',
        errorCode: err.code || 'FINALIZE_NEEDS_RECONCILE',
        errorMessage: err.message,
        replacementMap,
        finishedAt: Date.now(),
      });
      return buildOperationEnvelope(updated);
    }
  }

  async _processClaimFees(operation) {
    let receipt;
    try {
      const waitResult = await this.claimFeesService.waitForClaimReceipt({
        network: operation.network,
        version: operation.version,
        walletAddress: operation.walletAddress,
        positionIdentifier: operation.positionIdentifier,
        txHash: operation.txHashes[0],
        onProgress: (step) => {
          void this.operationRepo.updateState(operation.id, { status: step, step });
        },
      });
      receipt = waitResult.receipt;
    } catch (err) {
      await this._markFailed(operation.id, err);
      return null;
    }

    try {
      const result = await this.claimFeesService.finalizeClaimFeesAfterReceipt({
        network: operation.network,
        version: operation.version,
        walletAddress: operation.walletAddress,
        positionIdentifier: operation.positionIdentifier,
        txHash: operation.txHashes[0],
        receipt,
        onProgress: (step) => {
          void this.operationRepo.updateState(operation.id, { status: step, step });
        },
      });
      const updated = await this.operationRepo.updateState(operation.id, {
        status: 'done',
        step: 'done',
        result,
        finishedAt: Date.now(),
      });
      return buildOperationEnvelope(updated);
    } catch (err) {
      const updated = await this.operationRepo.updateState(operation.id, {
        status: 'needs_reconcile',
        step: 'needs_reconcile',
        errorCode: err.code || 'CLAIM_FEES_NEEDS_RECONCILE',
        errorMessage: err.message,
        finishedAt: Date.now(),
      });
      return buildOperationEnvelope(updated);
    }
  }

  async _markFailed(operationId, err) {
    const updated = await this.operationRepo.updateState(operationId, {
      status: 'failed',
      step: 'failed',
      errorCode: err.code || (err instanceof AppError ? err.code : 'UNISWAP_OPERATION_FAILED'),
      errorMessage: err.message || 'La operación falló',
      finishedAt: Date.now(),
    });
    return buildOperationEnvelope(updated);
  }
}

module.exports = new UniswapOperationService();
module.exports.UniswapOperationService = UniswapOperationService;
module.exports.buildOperationKey = buildOperationKey;
module.exports.buildOperationEnvelope = buildOperationEnvelope;

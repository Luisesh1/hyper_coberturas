#!/usr/bin/env node

const db = require('../db');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const realHlRegistry = require('../services/hyperliquid.registry');
const realSettingsService = require('../services/settings.service');
const { ProtectedPoolDeltaNeutralService } = require('../services/protected-pool-delta-neutral.service');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    protectionId: null,
    ticks: 5,
    simulateMissingPositionEvery: 0,
    dryRun: false,
    timelineOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--timeline-only') {
      options.timelineOnly = true;
    } else if (arg === '--protectionId') {
      options.protectionId = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--ticks') {
      options.ticks = Number(argv[index + 1] || options.ticks);
      index += 1;
    } else if (arg === '--simulate-missing-position-every') {
      options.simulateMissingPositionEvery = Number(argv[index + 1] || 0);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !Number.isInteger(options.protectionId)) {
    throw new Error('--protectionId es requerido');
  }
  if (!Number.isFinite(options.ticks) || options.ticks <= 0) {
    throw new Error('--ticks debe ser mayor a 0');
  }
  if (!Number.isFinite(options.simulateMissingPositionEvery) || options.simulateMissingPositionEvery < 0) {
    throw new Error('--simulate-missing-position-every debe ser 0 o mayor');
  }

  return options;
}

function printHelp() {
  console.log('Uso:');
  console.log('  node src/scripts/debug-delta-neutral-position-gap.js --protectionId 19 --ticks 10 --dry-run');
  console.log('  node src/scripts/debug-delta-neutral-position-gap.js --protectionId 19 --simulate-missing-position-every 2 --dry-run');
  console.log('  node src/scripts/debug-delta-neutral-position-gap.js --protectionId 19 --timeline-only');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryRepo(baseProtection) {
  const state = clone(baseProtection);
  return {
    state,
    async getById(_userId, id) {
      return Number(id) === Number(state.id) ? clone(state) : null;
    },
    async updateStrategyState(_userId, id, payload) {
      if (Number(id) !== Number(state.id)) return;
      if (payload.strategyState !== undefined) state.strategyState = clone(payload.strategyState);
      if (payload.priceCurrent !== undefined) state.priceCurrent = payload.priceCurrent;
      if (payload.snapshotStatus !== undefined) state.snapshotStatus = payload.snapshotStatus;
      if (payload.snapshotFreshAt !== undefined) state.snapshotFreshAt = payload.snapshotFreshAt;
      if (payload.snapshotHash !== undefined) state.snapshotHash = payload.snapshotHash;
      if (payload.nextEligibleAttemptAt !== undefined) state.nextEligibleAttemptAt = payload.nextEligibleAttemptAt;
      if (payload.cooldownReason !== undefined) state.cooldownReason = payload.cooldownReason;
      if (payload.lastDecision !== undefined) state.lastDecision = payload.lastDecision;
      if (payload.lastDecisionReason !== undefined) state.lastDecisionReason = payload.lastDecisionReason;
      if (payload.trackingErrorQty !== undefined) state.trackingErrorQty = payload.trackingErrorQty;
      if (payload.trackingErrorUsd !== undefined) state.trackingErrorUsd = payload.trackingErrorUsd;
      if (payload.executionMode !== undefined) state.executionMode = payload.executionMode;
      if (payload.hedgeSize !== undefined) state.hedgeSize = payload.hedgeSize;
      if (payload.hedgeNotionalUsd !== undefined) state.hedgeNotionalUsd = payload.hedgeNotionalUsd;
      state.updatedAt = Date.now();
    },
  };
}

function createDryRunTradingService() {
  return {
    async openPosition({ asset, size }) {
      return { fillPrice: 0, asset, size };
    },
    async closePosition({ asset, size }) {
      return { closePrice: 0, asset, size };
    },
  };
}

function createCapturingLogger() {
  const entries = [];
  return {
    entries,
    info(message, meta = {}) {
      entries.push({ level: 'info', message, ...meta });
    },
    warn(message, meta = {}) {
      entries.push({ level: 'warn', message, ...meta });
    },
    error(message, meta = {}) {
      entries.push({ level: 'error', message, ...meta });
    },
  };
}

function findLatestLog(entries, message) {
  const filtered = entries.filter((entry) => entry.message === message);
  return filtered.length ? filtered.at(-1) : null;
}

function toFixedOrNull(value, digits = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : null;
}

async function buildTimelineRows(protectionId) {
  const { rows } = await db.query(
    `SELECT id,
            decision,
            strategy_status,
            execution_skipped_because,
            target_qty,
            actual_qty,
            tracking_error_usd,
            created_at
       FROM protection_decision_log
      WHERE protected_pool_id = $1
      ORDER BY created_at ASC`,
    [protectionId],
  );

  return rows.map((row, index) => {
    const previous = rows[index - 1];
    const next = rows[index + 1];
    const contradiction = row.execution_skipped_because === 'insufficient_margin'
      && Number(row.actual_qty || 0) === 0
      && (
        Number(previous?.actual_qty || 0) > 0
        || Number(next?.actual_qty || 0) > 0
      );
    return {
      id: Number(row.id),
      when: new Date(Number(row.created_at)).toLocaleString('es-MX'),
      decision: row.decision,
      strategyStatus: row.strategy_status,
      skippedBecause: row.execution_skipped_because || '',
      targetQty: toFixedOrNull(row.target_qty, 6),
      actualQty: toFixedOrNull(row.actual_qty, 6),
      trackingErrorUsd: toFixedOrNull(row.tracking_error_usd, 2),
      contradiction,
    };
  });
}

async function runTimelineReport(protectionId) {
  const rows = await buildTimelineRows(protectionId);
  const contradictions = rows.filter((row) => row.contradiction);

  console.log('\nTimeline persistido');
  console.table(rows.slice(-25));
  console.log(`Contradicciones detectadas: ${contradictions.length}`);
  if (contradictions.length) {
    console.table(contradictions);
  }
}

async function runTickReplay(options) {
  const {
    rows: [identity],
  } = await db.query('SELECT user_id FROM protected_uniswap_pools WHERE id = $1', [options.protectionId]);
  if (!identity?.user_id) {
    throw new Error(`No se encontro la proteccion #${options.protectionId}`);
  }
  const protection = await protectedPoolRepository.getById(Number(identity.user_id), options.protectionId);
  if (!protection) {
    throw new Error(`No se encontro la proteccion #${options.protectionId}`);
  }

  const logger = createCapturingLogger();
  const memoryRepo = createMemoryRepo(protection);
  const baseClient = await realHlRegistry.getOrCreate(protection.userId, protection.accountId);
  let positionReadCount = 0;

  const wrappedClient = new Proxy(baseClient, {
    get(target, prop) {
      if (prop === 'getPosition') {
        return async (...args) => {
          positionReadCount += 1;
          const every = Number(options.simulateMissingPositionEvery || 0);
          if (every > 0 && (positionReadCount % every) === 0) {
            return null;
          }
          return target.getPosition(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: memoryRepo,
    protectionDecisionLogRepository: {
      async create() {},
    },
    deltaRebalanceLogRepository: {
      async create() {},
    },
    hlRegistry: {
      async getOrCreate() {
        return wrappedClient;
      },
    },
    getTradingService: async () => (options.dryRun ? createDryRunTradingService() : createDryRunTradingService()),
    settingsService: realSettingsService,
    logger,
  });

  const rows = [];
  for (let tick = 1; tick <= options.ticks; tick += 1) {
    logger.entries.length = 0;
    const result = await service.evaluateProtection(memoryRepo.state, {
      forceReason: tick === 1 ? 'restart_reconcile' : null,
    });
    const positionLog = findLatestLog(logger.entries, 'delta_neutral_position_observed');
    const preflightLog = findLatestLog(logger.entries, 'delta_neutral_preflight_result');
    rows.push({
      tick,
      positionSeen: positionLog ? (positionLog.positionObserved ? 'yes' : 'no') : '?',
      positionSource: positionLog?.positionReadSource || '',
      actualQty: toFixedOrNull(positionLog?.actualQtyEffective ?? result?.lastActualQty, 6),
      targetQty: toFixedOrNull(preflightLog?.targetQty ?? result?.lastTargetQty, 6),
      requiredMargin: toFixedOrNull(preflightLog?.requiredMarginUsd, 2),
      withdrawable: toFixedOrNull(preflightLog?.withdrawable, 2),
      preflightReason: preflightLog?.preflightReason || result?.lastError || '',
      strategyStatus: result?.status || memoryRepo.state?.strategyState?.status || '',
      lastDecision: result?.lastDecision || memoryRepo.state?.strategyState?.lastDecision || '',
    });
  }

  console.log('\nReplay por ticks');
  console.table(rows);
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  console.log(`Analizando proteccion #${options.protectionId}`);
  console.log(`Modo dry-run: ${options.dryRun ? 'si' : 'no'}`);
  if (options.simulateMissingPositionEvery > 0) {
    console.log(`Simulando lectura faltante cada ${options.simulateMissingPositionEvery} lecturas de posicion`);
  }

  if (!options.timelineOnly) {
    await runTickReplay(options);
  }
  await runTimelineReport(options.protectionId);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildTimelineRows,
};

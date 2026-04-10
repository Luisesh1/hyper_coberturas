-- LP Orchestrator: tabla principal + log de acciones
--
-- Un orquestador es una unidad de operación que gestiona UN LP activo a la
-- vez, pero a lo largo de su vida puede ir creando varios LPs sucesivos
-- (re-ranges, kills, recreates). La contabilidad es acumulada durante toda
-- la vida del orquestador (no se reinicia entre LPs).

CREATE TABLE IF NOT EXISTS lp_orchestrators (
  id                          SERIAL PRIMARY KEY,
  user_id                     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hyperliquid_account_id      INTEGER REFERENCES hyperliquid_accounts(id) ON DELETE SET NULL,

  -- Identidad
  name                        VARCHAR(255) NOT NULL,
  network                     VARCHAR(40)  NOT NULL,
  version                     VARCHAR(10)  NOT NULL,
  wallet_address              VARCHAR(255) NOT NULL,

  -- Par fijado en creación
  token0_address              VARCHAR(255) NOT NULL,
  token1_address              VARCHAR(255) NOT NULL,
  token0_symbol               VARCHAR(50)  NOT NULL,
  token1_symbol               VARCHAR(50)  NOT NULL,
  inferred_asset              VARCHAR(20),
  fee_tier                    INTEGER,

  -- Ciclo de vida
  phase                       VARCHAR(40) NOT NULL DEFAULT 'idle'
                              CHECK (phase IN (
                                'idle','lp_active','evaluating','needs_rebalance',
                                'urgent_adjust','executing','verifying','failed','complete'
                              )),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','stopped','archived')),

  -- LP activo (puede ser NULL entre kill y recreate)
  active_position_identifier  VARCHAR(255),
  active_pool_address         VARCHAR(255),
  active_protected_pool_id    INTEGER REFERENCES protected_uniswap_pools(id) ON DELETE SET NULL,
  initial_total_usd           NUMERIC NOT NULL,

  -- Configuración (estrategia + protección opcional)
  strategy_config_json        TEXT NOT NULL,
  protection_config_json      TEXT,

  -- Estado volátil
  strategy_state_json         TEXT,
  last_evaluation_json        TEXT,
  last_evaluation_at          BIGINT,

  -- Contabilidad acumulada (rolling totals)
  accounting_json             TEXT NOT NULL,

  -- Cooldowns / fallos
  next_eligible_attempt_at    BIGINT,
  cooldown_reason             TEXT,
  consecutive_failures        INTEGER NOT NULL DEFAULT 0,
  last_error                  TEXT,

  -- Alertas (para repetir cada N min hasta resolución)
  last_urgent_alert_at        BIGINT,
  last_decision               VARCHAR(40),

  -- Auditoría
  created_at                  BIGINT NOT NULL,
  updated_at                  BIGINT NOT NULL,
  stopped_at                  BIGINT
);

CREATE INDEX IF NOT EXISTS lp_orchestrators_user_status_idx
  ON lp_orchestrators(user_id, status, phase);

CREATE INDEX IF NOT EXISTS lp_orchestrators_active_loop_idx
  ON lp_orchestrators(status, next_eligible_attempt_at, updated_at DESC);

-- Garantiza un único LP activo por orquestador (a nivel DB)
CREATE UNIQUE INDEX IF NOT EXISTS lp_orchestrators_one_active_lp
  ON lp_orchestrators(id, active_position_identifier)
  WHERE status = 'active' AND active_position_identifier IS NOT NULL;


-- Log de toda decisión, ejecución y verificación.
CREATE TABLE IF NOT EXISTS lp_orchestrator_action_log (
  id                     SERIAL PRIMARY KEY,
  orchestrator_id        INTEGER NOT NULL REFERENCES lp_orchestrators(id) ON DELETE CASCADE,

  kind                   VARCHAR(40) NOT NULL
                         CHECK (kind IN (
                           'decision','tx_started','tx_finalized',
                           'verification','recovery','notification',
                           'accounting_snapshot','attach_lp','kill_lp','archive'
                         )),
  decision               VARCHAR(40),
  reason                 TEXT,
  action                 VARCHAR(40),
  position_identifier    VARCHAR(255),

  -- Contexto numérico
  current_price          NUMERIC,
  range_lower_price      NUMERIC,
  range_upper_price      NUMERIC,
  central_band_lower     NUMERIC,
  central_band_upper     NUMERIC,
  estimated_cost_usd     NUMERIC,
  estimated_reward_usd   NUMERIC,
  cost_to_reward_ratio   NUMERIC,
  snapshot_hash          VARCHAR(64),
  snapshot_freshness_ms  BIGINT,

  -- Post-acción
  tx_hashes_json         TEXT,
  realized_cost_usd      NUMERIC,

  -- Verificación
  verification_status    VARCHAR(20),
  drift_details_json     TEXT,

  -- Pre/post accounting deltas
  accounting_delta_json  TEXT,

  -- Payload libre
  payload_json           TEXT,

  created_at             BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS lp_orchestrator_action_log_orchestrator_idx
  ON lp_orchestrator_action_log(orchestrator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS lp_orchestrator_action_log_kind_idx
  ON lp_orchestrator_action_log(orchestrator_id, kind, created_at DESC);

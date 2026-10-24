-- Tramos del orquestador de LP: cada posicion (o rango) vivida es un tramo con
-- su propia contabilidad. El total del orquestador es la suma de sus tramos.

CREATE TABLE IF NOT EXISTS lp_orchestrator_segments (
  id                        SERIAL PRIMARY KEY,
  orchestrator_id           INTEGER NOT NULL REFERENCES lp_orchestrators(id) ON DELETE CASCADE,
  seq                       INTEGER NOT NULL,
  status                    VARCHAR(10) NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','closing','closed')),
  accuracy                  VARCHAR(12) NOT NULL DEFAULT 'exact'
                            CHECK (accuracy IN ('exact','approximate')),

  -- Identidad
  position_identifier       VARCHAR(255),
  pool_address              VARCHAR(255),
  protected_pool_id         INTEGER,
  policy_version            VARCHAR(40),

  -- Apertura
  opened_at                 BIGINT NOT NULL,
  open_price                NUMERIC,
  range_lower_price         NUMERIC,
  range_upper_price         NUMERIC,
  open_value_usd            NUMERIC,
  open_amount0              NUMERIC,
  open_amount1              NUMERIC,
  open_reason               VARCHAR(20),
  open_tx_hashes_json       TEXT,

  -- Cierre
  closing_started_at        BIGINT,
  closed_at                 BIGINT,
  close_price               NUMERIC,
  close_value_usd           NUMERIC,
  close_reason              VARCHAR(30),
  close_tx_hashes_json      TEXT,

  -- Contabilidad y baselines del tramo
  accounting_json           TEXT NOT NULL DEFAULT '{}',
  baseline_accounting_json  TEXT NOT NULL DEFAULT '{}',
  hedge_baseline_json       TEXT,
  shadow_baselines_json     TEXT,
  lp_baseline_snapshot_json TEXT,

  -- Cobertura
  hedge_open_qty            NUMERIC,
  hedge_close_qty           NUMERIC,
  coverage_json             TEXT,

  created_at                BIGINT NOT NULL,
  updated_at                BIGINT NOT NULL,

  UNIQUE (orchestrator_id, seq)
);

-- Invariante: un solo tramo vivo (open o closing) por orquestador.
CREATE UNIQUE INDEX IF NOT EXISTS lp_orchestrator_segments_one_live
  ON lp_orchestrator_segments(orchestrator_id)
  WHERE status IN ('open','closing');

ALTER TABLE lp_orchestrators
  ADD COLUMN IF NOT EXISTS active_segment_id INTEGER
  REFERENCES lp_orchestrator_segments(id) ON DELETE SET NULL;

ALTER TABLE lp_orchestrator_action_log
  ADD COLUMN IF NOT EXISTS segment_id INTEGER;
CREATE INDEX IF NOT EXISTS lp_orchestrator_action_log_segment_idx
  ON lp_orchestrator_action_log(segment_id);

ALTER TABLE protected_pool_delta_rebalance_log
  ADD COLUMN IF NOT EXISTS segment_id INTEGER;
CREATE INDEX IF NOT EXISTS protected_pool_delta_rebalance_log_segment_idx
  ON protected_pool_delta_rebalance_log(segment_id);

-- Siembra: no cambia el total de ningun orquestador. El acumulado previo
-- entra entero en un tramo historico aproximado (seq=1).
INSERT INTO lp_orchestrator_segments (
  orchestrator_id, seq, status, accuracy, opened_at, closed_at,
  open_reason, close_reason, accounting_json, baseline_accounting_json,
  created_at, updated_at
)
SELECT o.id, 1, 'closed', 'approximate', o.created_at,
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
       'deploy', 'unknown', o.accounting_json, '{}',
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint
  FROM lp_orchestrators o;

-- Extraccion defensiva del rango: JSON invalido o valores no numericos dan NULL
-- en vez de abortar la migracion.
CREATE FUNCTION pg_temp.seg046_range(ev text, bound text) RETURNS numeric AS $f$
BEGIN
  RETURN NULLIF(ev::jsonb #>> ARRAY['poolSnapshot', bound], '')::numeric;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$f$ LANGUAGE plpgsql;

-- Tramo vivo (seq=2) para los activos con LP; arranca con el acumulado actual
-- como baseline.
INSERT INTO lp_orchestrator_segments (
  orchestrator_id, seq, status, accuracy, position_identifier, pool_address,
  protected_pool_id, opened_at, range_lower_price, range_upper_price,
  open_reason, accounting_json, baseline_accounting_json, created_at, updated_at
)
SELECT o.id, 2, 'open', 'exact', o.active_position_identifier, o.active_pool_address,
       o.active_protected_pool_id,
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
       pg_temp.seg046_range(o.last_evaluation_json, 'rangeLowerPrice'),
       pg_temp.seg046_range(o.last_evaluation_json, 'rangeUpperPrice'),
       'deploy', '{}', o.accounting_json,
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint
  FROM lp_orchestrators o
 WHERE o.status = 'active' AND o.active_position_identifier IS NOT NULL;

UPDATE lp_orchestrators o
   SET active_segment_id = s.id
  FROM lp_orchestrator_segments s
 WHERE s.orchestrator_id = o.id AND s.seq = 2 AND s.status = 'open';

DROP FUNCTION pg_temp.seg046_range(text, text);

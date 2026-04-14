-- Snapshots horarios del valor total de cada orquestador.
-- Suma: wallet Arbitrum (ETH + todos los ERC-20) + LP Uniswap + cuenta HL.
--
-- Se captura cada hora en punto desde orchestrator-metrics.service.js y
-- alimenta la pagina /metricas del frontend.

CREATE TABLE IF NOT EXISTS orchestrator_metrics_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  orchestrator_id   INTEGER  NOT NULL REFERENCES lp_orchestrators(id) ON DELETE CASCADE,
  captured_at       BIGINT   NOT NULL,
  wallet_usd        NUMERIC(20,6),
  lp_usd            NUMERIC(20,6),
  hl_account_usd    NUMERIC(20,6),
  total_usd         NUMERIC(20,6) NOT NULL,
  breakdown_json    JSONB,
  created_at        BIGINT   NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
);

CREATE INDEX IF NOT EXISTS idx_metrics_orch_captured
  ON orchestrator_metrics_snapshots (orchestrator_id, captured_at DESC);

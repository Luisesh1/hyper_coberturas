-- Metricas por wallet: se sigue el valor total en USD (tokens en todas las
-- redes + LPs Uniswap + Hyperliquid de la misma direccion) de toda wallet con
-- la que se haya creado un orquestador, hasta que el usuario la archive.
--
-- `orchestrator_metrics_snapshots` (012) se conserva tal cual: ya no se
-- escribe, pero no se borra ni se migra.

CREATE TABLE IF NOT EXISTS tracked_wallets (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER      NOT NULL,
  address               VARCHAR(64)  NOT NULL,
  label                 VARCHAR(120),
  status                VARCHAR(12)  NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'archived')),
  archived_at           BIGINT,
  -- created_at del orquestador mas reciente con esta wallet. Un orquestador
  -- creado despues de archivar reactiva la wallet.
  last_orchestrator_at  BIGINT,
  -- Ultimo desglose completo (tokens, LPs, HL por fuente). Se sobrescribe en
  -- cada captura: alimenta el "detalle actual" y el ultimo valor conocido de
  -- cada fuente cuando una falla.
  last_detail           JSONB,
  created_at            BIGINT       NOT NULL,
  updated_at            BIGINT       NOT NULL,
  UNIQUE (user_id, address)
);

CREATE TABLE IF NOT EXISTS wallet_value_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  tracked_wallet_id  INTEGER       NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  captured_at        BIGINT        NOT NULL,
  total_usd          NUMERIC(20,6) NOT NULL,
  tokens_usd         NUMERIC(20,6) NOT NULL,
  lp_usd             NUMERIC(20,6) NOT NULL,
  hl_usd             NUMERIC(20,6) NOT NULL,
  is_partial         BOOLEAN       NOT NULL DEFAULT FALSE,
  -- [{ key, lastOkAt }] de las fuentes que reutilizaron su ultimo valor.
  stale_sources      JSONB,
  created_at         BIGINT        NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
);

CREATE INDEX IF NOT EXISTS idx_wallet_value_snapshots_wallet_captured
  ON wallet_value_snapshots (tracked_wallet_id, captured_at DESC);

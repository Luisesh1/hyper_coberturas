-- Fondeo cross-chain del asistente LP: planes de bridges persistidos para
-- poder reanudarlos, y observaciones de gas real para calibrar el oráculo de
-- comisiones. Spec: docs/superpowers/specs/2026-10-05-cross-chain-funding-design.md

CREATE TABLE IF NOT EXISTS cross_chain_plans (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  wallet_address      VARCHAR(64) NOT NULL,
  destination_network VARCHAR(40) NOT NULL,
  profile             VARCHAR(10) NOT NULL CHECK (profile IN ('low', 'medium', 'high')),
  threshold_pct       NUMERIC(6, 3) NOT NULL,
  status              VARCHAR(20) NOT NULL
    CHECK (status IN ('executing', 'delivered', 'partial', 'discarded')),
  -- Lo que pidió el asistente (pool, rango, objetivo, selección) y el
  -- análisis que se le mostró al usuario (cotizaciones y costos).
  request_json        JSONB NOT NULL,
  analysis_json       JSONB NOT NULL,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  finished_at         BIGINT
);

-- Un solo plan en curso por wallet: reanudar nunca tiene que elegir.
CREATE UNIQUE INDEX IF NOT EXISTS cross_chain_plans_one_active_idx
  ON cross_chain_plans (user_id, lower(wallet_address))
  WHERE status = 'executing';

CREATE TABLE IF NOT EXISTS cross_chain_steps (
  id                       BIGSERIAL PRIMARY KEY,
  plan_id                  BIGINT NOT NULL REFERENCES cross_chain_plans(id) ON DELETE CASCADE,
  step_order               INTEGER NOT NULL,
  source_network           VARCHAR(40) NOT NULL,
  token_address            VARCHAR(64) NOT NULL,
  token_symbol             VARCHAR(20) NOT NULL,
  token_decimals           INTEGER NOT NULL,
  is_native                BOOLEAN NOT NULL,
  delivery_token_address   VARCHAR(64) NOT NULL,
  amount_raw               NUMERIC(78, 0) NOT NULL,
  provider                 VARCHAR(10) NOT NULL CHECK (provider IN ('lifi', 'across')),
  carries_destination_gas  BOOLEAN NOT NULL DEFAULT FALSE,
  status                   VARCHAR(20) NOT NULL
    CHECK (status IN ('pending', 'signed', 'source_confirmed', 'delivered', 'failed', 'refunded', 'skipped')),
  -- Cotización normalizada (tx, approvals, fees, precios usados): lo que se
  -- firma sale de aquí, recotizado en cada prepare.
  quote_json               JSONB NOT NULL,
  approval_tx_hash         VARCHAR(80),
  tx_hash                  VARCHAR(80),
  nonce                    INTEGER,
  sent_fees_json           JSONB,
  est_cost_usd             NUMERIC(18, 6) NOT NULL,
  real_cost_usd            NUMERIC(18, 6),
  received_raw             NUMERIC(78, 0),
  eta_sec                  INTEGER,
  error_message            TEXT,
  wallet_overrode_fees     BOOLEAN NOT NULL DEFAULT FALSE,
  signed_at                BIGINT,
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  UNIQUE (plan_id, step_order)
);

CREATE INDEX IF NOT EXISTS cross_chain_steps_in_flight_idx
  ON cross_chain_steps (status)
  WHERE status IN ('signed', 'source_confirmed');

CREATE TABLE IF NOT EXISTS gas_observations (
  id                       BIGSERIAL PRIMARY KEY,
  network                  VARCHAR(40) NOT NULL,
  kind                     VARCHAR(40) NOT NULL,
  profile                  VARCHAR(10),
  estimated_gas            NUMERIC(20, 0),
  gas_used                 NUMERIC(20, 0) NOT NULL,
  effective_gas_price_wei  NUMERIC(40, 0) NOT NULL,
  l1_fee_wei               NUMERIC(40, 0),
  wait_blocks              INTEGER,
  tx_hash                  VARCHAR(80) NOT NULL UNIQUE,
  created_at               BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS gas_observations_lookup_idx
  ON gas_observations (network, kind, created_at DESC);

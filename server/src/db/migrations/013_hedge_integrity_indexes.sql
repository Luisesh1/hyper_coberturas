-- Integridad e índices adicionales en tablas de hedge / cycles.
--
-- Contexto: auditoría detectó dos riesgos:
--   1) Si el WebSocket de HL se reconecta y re-emite el mismo fill de
--      entrada (oid) cuando el ciclo ya se persistió, el fill se guarda
--      por segunda vez y se duplica el ciclo / el PnL histórico.
--   2) Queries del monitor por (hedge_id, status/open_orders) no tenían
--      índice auxiliar para status individual — ya existe hedges_status_idx
--      pero no un compuesto (user,status) que el dashboard consulta.
--
-- Este migration es idempotente: puede re-ejecutarse sin efecto si los
-- índices ya existen. Las UNIQUE se crean como índices PARCIALES para
-- permitir NULL (ciclos antiguos o en curso sin fill_oid aún).

-- (1) Deduplicar manualmente antes de crear UNIQUE. Borra ciclos
-- duplicados por (hedge_id, entry_fill_oid) conservando el de id menor.
-- Ejecutar solo si existen duplicados; de lo contrario no afecta.
DELETE FROM cycles a
USING cycles b
WHERE a.hedge_id = b.hedge_id
  AND a.entry_fill_oid IS NOT NULL
  AND a.entry_fill_oid = b.entry_fill_oid
  AND a.id > b.id;

DELETE FROM cycles a
USING cycles b
WHERE a.hedge_id = b.hedge_id
  AND a.exit_fill_oid IS NOT NULL
  AND a.exit_fill_oid = b.exit_fill_oid
  AND a.id > b.id;

-- UNIQUE parcial: un mismo fill_oid NO puede repetirse dentro del
-- mismo hedge. Protege ante re-emisiones del userEvent por parte de HL
-- o reinicios que vuelvan a procesar el mismo oid.
CREATE UNIQUE INDEX IF NOT EXISTS cycles_hedge_entry_fill_oid_unique
  ON cycles(hedge_id, entry_fill_oid)
  WHERE entry_fill_oid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cycles_hedge_exit_fill_oid_unique
  ON cycles(hedge_id, exit_fill_oid)
  WHERE exit_fill_oid IS NOT NULL;

-- Un mismo cycle_id tampoco puede repetirse dentro de un hedge.
CREATE UNIQUE INDEX IF NOT EXISTS cycles_hedge_cycle_id_unique
  ON cycles(hedge_id, cycle_id);

-- Índice compuesto para el dashboard: listar hedges activos por usuario
-- filtrando por estado. hedges_user_account_idx cubre (user,account) y
-- hedges_status_idx cubre status solo; este compuesto acelera el path
-- común "cargar mis coberturas abiertas" sin full scan.
CREATE INDEX IF NOT EXISTS hedges_user_status_idx
  ON hedges(user_id, status);

-- Índice para lookups de entrada pendiente por account+asset al recuperar
-- estado tras un reinicio del monitor. Las queries incluyen un IN de
-- estados, pero Postgres puede usar este índice como primer filtro.
CREATE INDEX IF NOT EXISTS hedges_account_asset_status_idx
  ON hedges(hyperliquid_account_id, asset, status);

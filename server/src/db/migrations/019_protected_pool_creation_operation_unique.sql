-- La migración 017 pudo aplicarse en entornos existentes cuando todavía había
-- un índice no único con otro nombre. Una migración ya registrada no vuelve a
-- ejecutarse, así que aseguramos explícitamente aquí la garantía exactly-once.

CREATE UNIQUE INDEX IF NOT EXISTS protected_pools_creation_operation_unique
  ON protected_uniswap_pools(creation_operation_id)
  WHERE creation_operation_id IS NOT NULL;

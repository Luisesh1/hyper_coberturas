-- Desglose de comisiones por posición: entrada, salida y ejercicio.
-- En filas nuevas fees_usdt = entry_fee_usdt + exit_fee_usdt + exercise_fee_usdt
-- (los NULL cuentan como 0 si la fila tiene desglose).
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS entry_fee_usdt NUMERIC NULL;
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS exit_fee_usdt NUMERIC NULL;
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS exercise_fee_usdt NUMERIC NULL;

-- Una posición abierta solo ha pagado la entrada. Las cerradas históricas
-- se quedan en NULL: no se puede repartir su total con fiabilidad.
UPDATE options_strategy_positions
   SET entry_fee_usdt = COALESCE(fees_usdt, 0)
 WHERE closed_at IS NULL AND entry_fee_usdt IS NULL;

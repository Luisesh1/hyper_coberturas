-- Objetivo de venta fijado al llenarse (bots por alertas con takeProfitMode
-- 'atr_band'): precio LIMIT y los datos con que se calculó (spot, banda,
-- distancia, apalancamiento, tope...). NULL = sin objetivo (otros modos) o
-- pendiente de calcular. Una vez escrito no se recalcula.

ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS tp_target_price NUMERIC;
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS tp_target_meta JSONB;

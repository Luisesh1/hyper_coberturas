-- Motivo con el que se cerro una posicion de opciones (stop_loss, expiry,
-- take_profit...). NULL cuando el cierre no lo conoce (p. ej. cierres reales
-- de una orden estandar); la UI muestra "—".

ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS close_reason VARCHAR(40);

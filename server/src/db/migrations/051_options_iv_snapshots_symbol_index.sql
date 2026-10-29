-- El simulador de salidas lee snapshots por símbolo y rango de tiempo
-- (listBySymbols); sin este índice recorre toda la tabla del periodo.
-- Índice normal (no concurrente): el migrador ejecuta cada archivo en una transacción.
CREATE INDEX IF NOT EXISTS idx_options_iv_snapshots_symbol_captured ON options_iv_snapshots (symbol, captured_at);

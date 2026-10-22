-- Señales simuladas desde la UI («Probar señal»): sin evento de alerta
-- (alert_event_id NULL, que el índice único no deduplica) y excluidas de los KPIs.
ALTER TABLE options_auto_signals
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;

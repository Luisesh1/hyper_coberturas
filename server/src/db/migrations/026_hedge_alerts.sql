-- Segundo canal de alertas, independiente de Telegram.
--
-- El 2026-09-01 los 24 de 24 envios a Telegram fallaron con un 400 y no quedo
-- rastro de ninguna alerta en ninguna parte: el unico canal era tambien el
-- unico registro. Y el 2026-09-21 pp27 paso ~72 h con $53.90 de short desnudo
-- mientras `delta_neutral_coverage_out_of_band` disparaba 5.265 veces en 3 h
-- sin salir de los logs del contenedor — que se pierden en cada rebuild.
--
-- Esta tabla es el registro durable: sobrevive al rebuild, se puede consultar
-- sin leer logs y permite exponer el estado por /api/health y /metrics sin
-- depender de que un mensaje saliente llegue a destino.
CREATE TABLE IF NOT EXISTS hedge_alerts (
  id                 BIGSERIAL PRIMARY KEY,
  protected_pool_id  INTEGER NOT NULL REFERENCES protected_uniswap_pools(id) ON DELETE CASCADE,
  alert_type         TEXT NOT NULL,
  severity           TEXT NOT NULL CHECK (severity IN ('warning', 'high', 'critical')),
  -- Agrupa los escalones de un mismo episodio: `naked_exposure` escala de
  -- warning a critical sin que eso sean tres problemas distintos.
  episode_started_at BIGINT NOT NULL,
  message            TEXT,
  details_json       JSONB,
  -- Se cierra cuando la condicion deja de cumplirse. Un episodio abierto es lo
  -- que degrada el health check.
  resolved_at        BIGINT,
  created_at         BIGINT NOT NULL
);

-- El acceso dominante es "episodios abiertos de esta proteccion", tanto para
-- decidir si hay que escalar como para el health check.
CREATE INDEX IF NOT EXISTS hedge_alerts_open_idx
  ON hedge_alerts (protected_pool_id, alert_type, episode_started_at)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS hedge_alerts_created_at_idx
  ON hedge_alerts (created_at DESC);

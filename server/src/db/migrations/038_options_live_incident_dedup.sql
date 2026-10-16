-- Notificaciones operativas persistentes para incidentes que no están
-- asociados necesariamente a un options_live_orders (órdenes manuales,
-- credenciales caídas, discrepancia de exposición, vencimientos pendientes).
CREATE TABLE IF NOT EXISTS options_live_incident_notifications (
  user_id INTEGER NOT NULL,
  incident_kind VARCHAR(40) NOT NULL,
  resource VARCHAR(120) NOT NULL,
  last_notified_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, incident_kind, resource)
);

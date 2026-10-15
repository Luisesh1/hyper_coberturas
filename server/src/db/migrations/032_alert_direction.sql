-- Dirección de las alertas: alcista, bajista o neutral.
-- Spec: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md (A).
--
--   alerts.direction        : las alertas que ya existen quedan en 'neutral'
--                             para que ningún bot empiece a operarlas solo.
--   alert_events.direction  : foto de la dirección en el momento del disparo
--                             (nullable: los eventos previos no la tienen).

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS direction VARCHAR(10) NOT NULL DEFAULT 'neutral'
    CHECK (direction IN ('bullish', 'bearish', 'neutral'));

ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS direction VARCHAR(10);

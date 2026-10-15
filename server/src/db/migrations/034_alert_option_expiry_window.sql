-- Cada alerta puede restringir el tiempo restante al vencimiento de las opciones.
-- NULL/NULL conserva el comportamiento previo (sin restricción adicional).
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS option_expiry_min_days NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS option_expiry_max_days NUMERIC(8,3);

ALTER TABLE alerts
  ADD CONSTRAINT alerts_option_expiry_range_check CHECK (
    (option_expiry_min_days IS NULL AND option_expiry_max_days IS NULL)
    OR (
      option_expiry_min_days > 0
      AND option_expiry_max_days >= option_expiry_min_days
      AND option_expiry_max_days <= 180
    )
  );

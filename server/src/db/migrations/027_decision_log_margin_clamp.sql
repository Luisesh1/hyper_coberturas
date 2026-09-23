-- Registrar el RECORTE por margen, no solo el rechazo.
--
-- Desde el 2026-09-22 el preflight, en vez de rechazar entero un incremento
-- que el colateral no aguanta, lo recorta a lo que si cabe: entrar al 60% y
-- completar en el tick siguiente domina a quedarse en 0. Eso arreglo el modo
-- de fallo que dejo a pp24 siete dias con `actual_qty = 0.00010` contra un
-- target de 0.068.
--
-- Pero el recorte solo se registraba en los logs del contenedor, que se
-- pierden en cada rebuild. `execution_skipped_because` no sirve: describe un
-- salto, y un recorte es lo contrario — se ejecuto, solo que menos. Resultado:
-- el panel contaba los rechazos y era ciego a los recortes, justo durante la
-- ventana de medicion de la Fase 6.
--
-- `margin_clamped_from_qty` no nulo = hubo recorte. Se guarda lo PEDIDO; lo
-- concedido ya vive en `target_qty`, y la diferencia entre ambos es lo que el
-- colateral no alcanzo a cubrir.
ALTER TABLE protection_decision_log
  ADD COLUMN IF NOT EXISTS margin_clamped_from_qty NUMERIC;

-- Parcial: los recortes son una minoria de las filas y la tabla es la mas
-- grande del esquema (llego a 6,5 M antes de la poda del 2026-09-22).
CREATE INDEX IF NOT EXISTS protection_decision_log_margin_clamp_idx
  ON protection_decision_log (protected_pool_id, created_at DESC)
  WHERE margin_clamped_from_qty IS NOT NULL;

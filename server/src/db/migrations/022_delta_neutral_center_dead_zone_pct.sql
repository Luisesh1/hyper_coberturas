-- Zona central del rango donde la cobertura delta-neutral NO rebalancea.
--
-- Se expresa como porcentaje del ancho TOTAL del rango, centrada en su punto
-- medio geometrico: 40 congela los rebalanceos mientras el precio este entre
-- el 30% y el 70% del rango. Con el precio profundo en rango el delta se mueve
-- despacio y cada ajuste paga taker fee + slippage y realiza PnL del hedge,
-- asi que ese churn no se recupera.
--
-- NULL = usar el default del servicio (config.deltaNeutral.centerDeadZonePct,
-- 40 salvo override por env). Las protecciones existentes quedan en NULL a
-- proposito: heredan el default sin tener que reescribirlas, y basta cambiar
-- la config para mover a todas a la vez.
ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS center_dead_zone_pct NUMERIC;

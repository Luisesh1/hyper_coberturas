-- El umbral de drift que habilita el rebalanceo por temporizador pasa de ser
-- un absoluto en USD a un porcentaje del valor VIVO del LP protegido.
--
-- Motivo: el absoluto se congelaba al crear la proteccion y no seguia al LP.
-- Un LP de ~$50 con el default de $50 dejaba el brazo del temporizador
-- inalcanzable (el hedge tenia que estar equivocado al 100% para disparar), y
-- la cobertura se quedaba colgada tras un increase/decrease de liquidez.
--
-- Los absolutos viejos NO se convierten: no hay forma fiable de derivar un
-- porcentaje sin el valor del LP en el momento en que se configuraron. Se
-- conservan renombrados por si hiciera falta auditarlos, y las protecciones
-- existentes pasan a NULL = default del servicio.
ALTER TABLE protected_uniswap_pools
  RENAME COLUMN min_rebalance_notional_usd TO min_rebalance_notional_usd_legacy;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS min_rebalance_notional_pct NUMERIC;

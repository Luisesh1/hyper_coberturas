-- El rango de vencimiento pasa de la alerta al bot de opciones (alert_signal):
-- params.expiryMinDays / params.expiryMaxDays. Se copia el rango de las
-- alertas vinculadas a los bots que aún no tienen uno, para que ningún bot
-- amplíe su selección de vencimientos tras el cambio. Con varias alertas con
-- rango se usa la intersección; si no se solapan, la unión.
-- Las columnas alerts.option_expiry_* se conservan (sin uso) por seguridad.
WITH windows AS (
  SELECT s.id,
         MAX(a.option_expiry_min_days) AS lo_i,
         MIN(a.option_expiry_max_days) AS hi_i,
         MIN(a.option_expiry_min_days) AS lo_u,
         MAX(a.option_expiry_max_days) AS hi_u
    FROM options_strategies s
    JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(s.params->'alertIds') = 'array' THEN s.params->'alertIds' ELSE '[]'::jsonb END
         ) AS ids(alert_id) ON TRUE
    JOIN alerts a
      ON a.id::text = ids.alert_id
     AND a.user_id = s.user_id
     AND a.option_expiry_min_days IS NOT NULL
     AND a.option_expiry_max_days IS NOT NULL
   WHERE s.template = 'alert_signal'
     AND s.params->'expiryMinDays' IS NULL
     AND s.params->'expiryMaxDays' IS NULL
   GROUP BY s.id
)
UPDATE options_strategies s
   SET params = s.params || jsonb_build_object(
         'expiryMinDays', (CASE WHEN w.lo_i <= w.hi_i THEN w.lo_i ELSE w.lo_u END)::float8,
         'expiryMaxDays', (CASE WHEN w.lo_i <= w.hi_i THEN w.hi_i ELSE w.hi_u END)::float8
       )
  FROM windows w
 WHERE s.id = w.id;

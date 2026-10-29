-- Rango de la prima durante la vida de una posición: el máximo y el mínimo del
-- precio de cierre ejecutable (bid si se compró, ask si se vendió) y cuándo se
-- alcanzó cada uno. Lo muestrea `options-premium-sampler` cada minuto; el
-- precio de salida se combina al leer (mapPosition), no se guarda aquí.
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS premium_high NUMERIC NULL;
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS premium_high_at BIGINT NULL;
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS premium_low NUMERIC NULL;
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS premium_low_at BIGINT NULL;
-- 'full': muestreada desde que se abrió. 'partial': abierta antes del
-- muestreo; su rango sale de los snapshots horarios y/o de las muestras
-- posteriores. NULL: sin registro.
ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS premium_range_source VARCHAR(10) NULL;
ALTER TABLE options_strategy_positions ALTER COLUMN premium_range_source SET DEFAULT 'full';

-- Posiciones previas: rango aproximado con los snapshots horarios de la
-- cadena (options_iv_snapshots) entre la apertura y el cierre.
WITH samples AS (
  SELECT p.id, s.captured_at AS at,
         CASE WHEN p.side = 'BUY' THEN s.bid ELSE s.ask END AS price
    FROM options_strategy_positions p
    JOIN options_iv_snapshots s
      ON s.underlying = split_part(p.symbol, '-', 1)
     AND s.symbol = p.symbol
     AND s.captured_at >= p.opened_at
     AND s.captured_at <= COALESCE(p.closed_at, 9223372036854775807)
   WHERE p.premium_range_source IS NULL
), valid AS (
  SELECT * FROM samples WHERE price > 0
), high AS (
  SELECT DISTINCT ON (id) id, price, at FROM valid ORDER BY id, price DESC, at
), low AS (
  SELECT DISTINCT ON (id) id, price, at FROM valid ORDER BY id, price ASC, at
)
UPDATE options_strategy_positions p
   SET premium_high = high.price, premium_high_at = high.at,
       premium_low = low.price, premium_low_at = low.at,
       premium_range_source = 'partial'
  FROM high JOIN low USING (id)
 WHERE p.id = high.id;

-- Las abiertas sin snapshots se muestrean desde ahora: rango parcial.
UPDATE options_strategy_positions
   SET premium_range_source = 'partial'
 WHERE closed_at IS NULL AND premium_range_source IS NULL;

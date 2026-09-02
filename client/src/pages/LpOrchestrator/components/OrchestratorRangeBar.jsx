import { getRangeBarData } from '../../UniswapPools/utils/pool-helpers';
import { formatCompactPrice } from '../../UniswapPools/utils/pool-formatters';
import { formatNumber, formatDuration } from '../../../utils/formatters';
import styles from './OrchestratorRangeBar.module.css';

function getBoundedPinLeft(pct) {
  if (pct == null) return undefined;
  return `clamp(40px, ${pct}%, calc(100% - 40px))`;
}

// Tope del servidor (`MAX_CENTER_DEAD_ZONE_PCT`). Un valor mayor no se puede
// persistir, y recortar aca evita dibujar una banda mas ancha que el rango si
// llegara uno viejo o corrupto.
const MAX_DEAD_ZONE_PCT = 90;

/**
 * Tramo del rango donde la COBERTURA no opera, en coordenadas del track.
 *
 * `zone` es el `noOpZone` que arma el servidor a partir de la politica viva:
 * `center` (banda central de pct% — zonas legacy y net profit), `full_range`
 * (`range_exit_v1`: dentro del rango no toca el hedge) o `none`.
 *
 * La banda central se centra en el medio GEOMETRICO, no en el aritmetico: el
 * motor ubica el precio dentro del rango en escala logaritmica
 * (`rangePositionFraction`), mientras que este track es lineal en precio.
 * Centrarla en el 50% del ancho dibujaria una zona corrida respecto de la que
 * el hedge realmente usa — poco en un rango del 5%, cada vez mas a medida que
 * el rango se ensancha.
 */
export function computeNoOpBand({
  zone, lowerPrice, upperPrice, rangeLowPct, rangeHighPct,
}) {
  const lower = Number(lowerPrice);
  const upper = Number(upperPrice);
  if (!zone || zone.kind === 'none') return null;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) return null;

  const toTrackPct = (price) => (
    rangeLowPct + ((price - lower) / (upper - lower)) * (rangeHighPct - rangeLowPct)
  );

  if (zone.kind === 'full_range') {
    return {
      kind: 'full_range',
      leftPct: rangeLowPct,
      widthPct: rangeHighPct - rangeLowPct,
      lowerPrice: lower,
      upperPrice: upper,
      pct: 100,
    };
  }

  const width = Number(zone.pct);
  if (!Number.isFinite(width) || width <= 0) return null;

  const half = Math.min(width, MAX_DEAD_ZONE_PCT) / 200;
  const ratio = upper / lower;
  const priceAt = (fraction) => lower * (ratio ** fraction);
  const lowPrice = priceAt(0.5 - half);
  const highPrice = priceAt(0.5 + half);

  return {
    kind: 'center',
    leftPct: toTrackPct(lowPrice),
    widthPct: toTrackPct(highPrice) - toTrackPct(lowPrice),
    lowerPrice: lowPrice,
    upperPrice: highPrice,
    pct: Math.min(width, MAX_DEAD_ZONE_PCT),
  };
}

/**
 * Range bar específico del orquestador. A diferencia de RangeTrack, divide
 * visualmente el rango del LP en TRES zonas controladas por la estrategia:
 *
 *   [edge_lower] | [central / no-adjustment] | [edge_upper]
 *      warn      |          ok               |     warn
 *
 * Marca dos pins: el precio de apertura del LP (ámbar) y el precio actual,
 * cuyo color refleja la zona en la que se encuentra (verde / ámbar / rojo).
 */
export default function OrchestratorRangeBar({
  pool,
  edgeMarginPct = 40,
  activeForMs = null,
  hedge = null,
}) {
  const rangeBar = getRangeBarData(pool);
  if (!rangeBar) return null;

  const { rangeLowPct, rangeHighPct, openPct, currentPct, lowerPrice, upperPrice, openPrice, currentPrice } = rangeBar;
  const rangeWidthDom = rangeHighPct - rangeLowPct;
  if (rangeWidthDom <= 0) return null;

  // Banda central: el (100 - 2*edgeMarginPct)% central del rango LP.
  const margin = Math.max(0, Math.min(49, Number(edgeMarginPct) || 0));
  const centralLowPct = rangeLowPct + (rangeWidthDom * margin) / 100;
  const centralHighPct = rangeHighPct - (rangeWidthDom * margin) / 100;

  // ¿Está el precio actual dentro del rango y en qué zona?
  // El tone se usa internamente para colorear el marker / pin del precio
  // actual; el badge de estado vive en el header de la card, no aquí, para
  // no duplicar la etiqueta de fase.
  const inRange = pool?.currentOutOfRangeSide == null;
  const inCentralBand = inRange && currentPct != null
    && currentPct >= centralLowPct && currentPct <= centralHighPct;

  let statusTone;
  if (!inRange) statusTone = 'urgent';
  else if (inCentralBand) statusTone = 'ok';
  else statusTone = 'warn';

  const rangeWidthPct = Number.isFinite(lowerPrice) && lowerPrice > 0 && Number.isFinite(upperPrice)
    ? ((upperPrice - lowerPrice) / lowerPrice) * 100
    : null;

  // Zona sin operacion de la cobertura. Sale de la politica que ESTA
  // corriendo, no de lo que pida el formulario: describe lo que el motor hace.
  const deadZone = computeNoOpBand({
    zone: hedge?.noOpZone, lowerPrice, upperPrice, rangeLowPct, rangeHighPct,
  });
  const noOpNone = hedge?.noOpZone?.kind === 'none';
  // El estado "ahora congelada" se deriva del MISMO precio que se dibuja, no
  // del flag que persistio el tick: asi la frase no puede contradecir a la
  // figura que esta encima.
  const frozenNow = Boolean(deadZone)
    && inRange
    && Number.isFinite(currentPrice)
    && currentPrice >= deadZone.lowerPrice
    && currentPrice <= deadZone.upperPrice;

  const openPinLeft = getBoundedPinLeft(openPct);
  const currentPinLeft = getBoundedPinLeft(currentPct);

  // Edad del LP — activeForMs viene pre-calculado del backend; como fallback
  // lo calculamos desde pool.openedAt (segundos) para que el label aparezca
  // aun cuando la prop no se haya propagado todavía.
  const lpAgeMs = Number.isFinite(activeForMs) && activeForMs > 0
    ? activeForMs
    : (pool?.openedAt ? Math.max(0, Date.now() - Number(pool.openedAt) * 1000) : null);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Rango</span>
        {lpAgeMs != null && (
          <span className={styles.headerAge} title="Tiempo transcurrido desde la apertura del LP">
            LP abierto hace {formatDuration(lpAgeMs)}
          </span>
        )}
      </div>

      {/* Pin del precio actual ARRIBA del track */}
      <div className={`${styles.pinsRow} ${styles.pinsRowTop}`}>
        {currentPct != null && (
          <div className={`${styles.pin} ${styles.pinTop} ${styles[`pinCurrent_${statusTone}`]}`} style={{ left: currentPinLeft }}>
            <span className={styles.pinValue}>{formatCompactPrice(currentPrice)}</span>
            <span className={styles.pinLabel}>Actual</span>
          </div>
        )}
      </div>

      {/* Corchete rotulado: la zona de la cobertura lleva su nombre escrito
          encima, en vez de depender de que alguien ate una textura a una
          leyenda tres líneas más abajo. */}
      {deadZone && (
        <div className={styles.bracketRow}>
          <div
            className={styles.bracket}
            style={{ left: `${deadZone.leftPct}%`, width: `${deadZone.widthPct}%` }}
          />
          <span
            className={styles.bracketLabel}
            style={{ left: `${deadZone.leftPct + deadZone.widthPct / 2}%` }}
          >
            Cobertura congelada
          </span>
        </div>
      )}

      <div className={styles.track}>
        {/* Borde inferior (warning zone) */}
        <div
          className={`${styles.zone} ${styles.zoneEdge}`}
          style={{ left: `${rangeLowPct}%`, width: `${centralLowPct - rangeLowPct}%` }}
        />
        {/* Banda central (no-adjustment zone) */}
        <div
          className={`${styles.zone} ${styles.zoneCentral}`}
          style={{ left: `${centralLowPct}%`, width: `${centralHighPct - centralLowPct}%` }}
        />
        {/* Borde superior (warning zone) */}
        <div
          className={`${styles.zone} ${styles.zoneEdge}`}
          style={{ left: `${centralHighPct}%`, width: `${rangeHighPct - centralHighPct}%` }}
        />

        {/* Edges del rango LP */}
        <div className={styles.edge} style={{ left: `${rangeLowPct}%` }} />
        <div className={styles.edge} style={{ left: `${rangeHighPct}%` }} />
        {/* Edges de la banda central (líneas más suaves) */}
        <div className={styles.centralEdge} style={{ left: `${centralLowPct}%` }} />
        <div className={styles.centralEdge} style={{ left: `${centralHighPct}%` }} />

        {/* Zona muerta de la COBERTURA: la ÚNICA región del track con relleno
            propio. Las zonas del LP quedan de fondo tenue (ver .zoneEdge /
            .zoneCentral): con las dos al mismo peso, dos bandas centradas de
            anchos distintos se leían como una sola mal dibujada. */}
        {deadZone && (
          <div
            className={`${styles.deadZone} ${frozenNow ? styles.deadZoneActive : ''}`}
            style={{ left: `${deadZone.leftPct}%`, width: `${deadZone.widthPct}%` }}
            title={deadZone.kind === 'full_range'
              ? 'La cobertura no rebalancea mientras el precio siga dentro del rango'
              : `La cobertura no rebalancea entre ${formatCompactPrice(deadZone.lowerPrice)} y ${formatCompactPrice(deadZone.upperPrice)} — el ${formatNumber(deadZone.pct, 0)}% central del rango`}
          />
        )}

        {/* Marker de precio de apertura */}
        {openPct != null && (
          <div className={`${styles.marker} ${styles.markerOpen}`} style={{ left: `${openPct}%` }} />
        )}
        {/* Marker de precio actual coloreado según zona */}
        {currentPct != null && (
          <div
            className={`${styles.marker} ${styles[`markerCurrent_${statusTone}`]}`}
            style={{ left: `${currentPct}%` }}
          />
        )}
      </div>

      {/* Pin del precio de apertura DEBAJO del track */}
      <div className={`${styles.pinsRow} ${styles.pinsRowBottom}`}>
        {openPct != null && (
          <div className={`${styles.pin} ${styles.pinBottom} ${styles.pinOpen}`} style={{ left: openPinLeft }}>
            <span className={styles.pinLabel}>Apertura</span>
            <span className={styles.pinValue}>{formatCompactPrice(openPrice)}</span>
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.edgeValue}>{formatCompactPrice(lowerPrice)}</span>
        <span className={styles.caption}>
          {pool.priceQuoteSymbol && pool.priceBaseSymbol
            ? `${pool.priceQuoteSymbol}/${pool.priceBaseSymbol}`
            : 'precio'}
          {rangeWidthPct != null ? ` · ${formatNumber(rangeWidthPct, 2)}% · centro ${(100 - 2 * margin).toFixed(0)}%` : ''}
        </span>
        <span className={styles.edgeValue}>{formatCompactPrice(upperPrice)}</span>
      </div>

      {deadZone && (
        <div className={styles.deadZoneLegend}>
          <span className={styles.legendChip}>
            <span className={styles.deadZoneSwatch} aria-hidden="true" />
            {deadZone.kind === 'full_range' ? (
              <>todo el rango: sólo reajusta al salir y al volver a entrar</>
            ) : (
              <strong className={styles.legendRange}>
                {formatCompactPrice(deadZone.lowerPrice)}–{formatCompactPrice(deadZone.upperPrice)}
              </strong>
            )}
          </span>
          <span className={styles.legendChip}>
            <span className={styles.centralSwatch} aria-hidden="true" />
            centro del LP
          </span>
          <span className={frozenNow ? styles.deadZoneNowFrozen : styles.deadZoneNowLive}>
            {frozenNow ? 'ahora no rebalancea' : 'ahora sí rebalancea'}
          </span>
        </div>
      )}

      {/* Que NO haya zona muerta también hay que decirlo: sin esta línea, la
          ausencia de banda se lee como "no me fijé" y no como "sigue al delta
          en todo el rango", que es una configuración distinta y deliberada. */}
      {noOpNone && (
        <div className={styles.deadZoneLegend}>
          <span>Sin zona muerta: la cobertura sigue al delta en todo el rango.</span>
        </div>
      )}

    </div>
  );
}

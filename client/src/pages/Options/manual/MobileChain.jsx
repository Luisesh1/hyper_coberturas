import { fmtIv, fmtNum, fmtPrice, fmtSpot, fmtStrike } from '../format';
import styles from './ManualTrading.module.css';
import { quoteMid, optionPremiumLeverage } from './mobileChainMetrics';
import ChainBadges, { MarkIcon } from './ChainBadges';
import { markAria, markShort } from './chainMarks';

// Índice de la primera fila por encima del spot: ahí va el separador.
export function spotDividerIndex(rows, spot) {
  const S = Number(spot);
  if (!rows?.length || !Number.isFinite(S)) return -1;
  const i = rows.findIndex((r) => r.strike > S);
  return i > 0 ? i : -1;
}

// In the money: call con strike bajo el spot; put con strike sobre el spot.
export function isItm(type, strike, spot) {
  const S = Number(spot);
  if (!Number.isFinite(S)) return false;
  return type === 'C' ? strike < S : strike > S;
}

// Cadena móvil: un solo lado (calls o puts), filas de 52 px que abren el
// ticket, con el spot marcado entre strikes.
// Cuántas patas del lado dado tienen posición u orden en este vencimiento.
function sideCounts(rows, key, marks) {
  const c = { positions: 0, orders: 0 };
  if (!marks?.bySymbol.size) return c;
  for (const r of rows) {
    const m = r[key]?.symbol ? marks.bySymbol.get(r[key].symbol) : null;
    if (m?.position) c.positions += 1;
    if (m?.orders.length) c.orders += 1;
  }
  return c;
}

function TypeCounts({ counts }) {
  if (!counts.positions && !counts.orders) return null;
  return (
    <span className={styles.badgeGroup} aria-hidden="true" title={`${counts.positions} con posición, ${counts.orders} con órdenes`}>
      {counts.positions > 0 && <span className={`${styles.badge} ${styles.badgePos}`} aria-hidden="true"><MarkIcon kind="star" />{counts.positions}</span>}
      {counts.orders > 0 && <span className={`${styles.badge} ${styles.badgeOrd}`} aria-hidden="true"><MarkIcon kind="up" /><MarkIcon kind="down" />{counts.orders}</span>}
    </span>
  );
}

export default function MobileChain({ chain, loading, error, type, onType, selectedSymbol, onPickRow, marks = null }) {
  const rows = chain?.rows || [];
  const callCounts = sideCounts(rows, 'call', marks);
  const putCounts = sideCounts(rows, 'put', marks);
  const divider = spotDividerIndex(rows, chain?.spot);
  const key = type === 'C' ? 'call' : 'put';

  return (
    <section aria-label="Cadena de opciones">
      <div className={styles.typeBar}>
        <div role="group" aria-label="Tipo" className={styles.typeSeg}>
          <button
            type="button"
            className={`${styles.typeBtn} ${type === 'C' ? styles.typeCallOn : ''}`}
            aria-pressed={type === 'C'}
            onClick={() => onType('C')}
          >
            Calls
            <TypeCounts counts={callCounts} />
          </button>
          <button
            type="button"
            className={`${styles.typeBtn} ${type === 'P' ? styles.typePutOn : ''}`}
            aria-pressed={type === 'P'}
            onClick={() => onType('P')}
          >
            Puts
            <TypeCounts counts={putCounts} />
          </button>
        </div>
        <span className={`${styles.typeHint} ${styles.itmLegend}`}>
          <span className={styles.itmSwatch} aria-hidden="true" />ITM · Toca un strike
        </span>
      </div>

      <div className={`${styles.mGrid} ${styles.mHead}`} aria-hidden="true">
        <span>Strike · IV</span><span className={styles.mQuoteHead}>Bid / Prom / Ask</span><span>Δ</span><span title="Nocional del subyacente / prima al ask (no es apalancamiento delta)">Apal.</span>
      </div>

      {error && !rows.length ? (
        <p className={styles.empty} role="alert">No se pudo cargar la cadena: {error.message}</p>
      ) : !rows.length ? (
        <p className={styles.empty}>{loading ? 'Cargando cadena…' : 'Sin contratos para este vencimiento.'}</p>
      ) : (
        <div>
          {rows.map((r, i) => {
            const leg = r[key];
            if (!leg?.symbol) return null;
            const on = leg.symbol === selectedSymbol;
            const itm = isItm(type, r.strike, chain?.spot);
            const mid = quoteMid(leg.bid, leg.ask);
            const leverage = optionPremiumLeverage(chain?.spot, leg.ask);
            const mark = marks?.bySymbol.get(leg.symbol);
            const summary = markShort(mark);
            const markCls = mark?.position ? styles.mRowPos : mark?.orders.length ? styles.mRowOrd : '';
            return (
              <div key={r.strike}>
                {i === divider && (
                  <div className={styles.spotDivider}>
                    <span className={`${styles.mono} ${styles.spotDividerLabel}`}>Spot {fmtSpot(chain.spot)}</span>
                  </div>
                )}
                <button
                  type="button"
                  className={`${styles.mRow} ${styles.mGrid} ${itm ? styles.mRowItm : ''} ${on ? styles.mRowOn : ''} ${markCls}`}
                  aria-label={`${type === 'C' ? 'Call' : 'Put'} ${fmtStrike(r.strike)}${itm ? ', dentro del dinero' : ''}, bid ${fmtPrice(leg.bid)}, promedio ${fmtPrice(mid)}, ask ${fmtPrice(leg.ask)}, apalancamiento por prima ${leverage == null ? 'no disponible' : fmtNum(leverage, 1) + ' veces'}${markAria(mark)}`}
                  onClick={() => onPickRow({ leg, strike: r.strike, type })}
                >
                  <span className={styles.mStrike}>
                    <span className={`${styles.mono} ${styles.mStrikeVal}`}>{fmtStrike(r.strike)}</span>
                    {summary
                      ? (
                        <span className={styles.mStrikeLine} aria-hidden="true">
                          <ChainBadges mark={mark} />
                          <span className={`${styles.mono} ${styles.mMarkLine} ${mark.position ? styles.mMarkPos : styles.mMarkOrd}`}>{summary}</span>
                        </span>
                      )
                      : <span className={`${styles.mono} ${styles.mIv}`}>IV {fmtIv(leg.iv)}</span>}
                  </span>
                  <span className={`${styles.mono} ${styles.mQuoteCell}`}>
                    <span className={`${styles.mQuoteSide} ${styles.down}`}>{fmtPrice(leg.bid)}</span>
                    <strong className={styles.mQuoteMid}>{fmtPrice(mid)}</strong>
                    <span className={`${styles.mQuoteSide} ${styles.up}`}>{fmtPrice(leg.ask)}</span>
                  </span>
                  <span className={`${styles.mono} ${styles.mDelta}`}>{fmtNum(leg.delta, 2)}</span>
                  <span className={`${styles.mono} ${styles.mLeverage}`}>
                    {leverage == null ? '—' : `${fmtNum(leverage, 1)}x`}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

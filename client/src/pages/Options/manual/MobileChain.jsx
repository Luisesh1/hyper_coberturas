import { fmtIv, fmtNum, fmtPrice, fmtSpot, fmtStrike } from '../format';
import styles from './ManualTrading.module.css';
import { quoteMid, optionPremiumLeverage } from './mobileChainMetrics';

// Índice de la primera fila por encima del spot: ahí va el separador.
export function spotDividerIndex(rows, spot) {
  const S = Number(spot);
  if (!rows?.length || !Number.isFinite(S)) return -1;
  const i = rows.findIndex((r) => r.strike > S);
  return i > 0 ? i : -1;
}

// Cadena móvil: un solo lado (calls o puts), filas de 52 px que abren el
// ticket, con el spot marcado entre strikes.
export default function MobileChain({ chain, loading, error, type, onType, selectedSymbol, onPickRow }) {
  const rows = chain?.rows || [];
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
          </button>
          <button
            type="button"
            className={`${styles.typeBtn} ${type === 'P' ? styles.typePutOn : ''}`}
            aria-pressed={type === 'P'}
            onClick={() => onType('P')}
          >
            Puts
          </button>
        </div>
        <span className={styles.typeHint}>Toca un strike</span>
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
            const mid = quoteMid(leg.bid, leg.ask);
            const leverage = optionPremiumLeverage(chain?.spot, leg.ask);
            return (
              <div key={r.strike}>
                {i === divider && (
                  <div className={styles.spotDivider}>
                    <span className={`${styles.mono} ${styles.spotDividerLabel}`}>Spot {fmtSpot(chain.spot)}</span>
                  </div>
                )}
                <button
                  type="button"
                  className={`${styles.mRow} ${styles.mGrid} ${on ? styles.mRowOn : ''}`}
                  aria-label={`${type === 'C' ? 'Call' : 'Put'} ${fmtStrike(r.strike)}, bid ${fmtPrice(leg.bid)}, promedio ${fmtPrice(mid)}, ask ${fmtPrice(leg.ask)}, apalancamiento por prima ${leverage == null ? 'no disponible' : fmtNum(leverage, 1) + ' veces'}`}
                  onClick={() => onPickRow({ leg, strike: r.strike, type })}
                >
                  <span className={styles.mStrike}>
                    <span className={`${styles.mono} ${styles.mStrikeVal}`}>{fmtStrike(r.strike)}</span>
                    <span className={`${styles.mono} ${styles.mIv}`}>IV {fmtIv(leg.iv)}</span>
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

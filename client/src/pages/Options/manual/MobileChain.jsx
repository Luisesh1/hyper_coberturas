import { fmtIv, fmtNum, fmtPrice, fmtSpot, fmtStrike } from '../format';
import styles from './ManualTrading.module.css';

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
        <span>Strike · IV</span><span>Bid</span><span>Ask</span><span>Δ</span>
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
                  aria-label={`${type === 'C' ? 'Call' : 'Put'} ${fmtStrike(r.strike)}, bid ${fmtPrice(leg.bid)}, ask ${fmtPrice(leg.ask)}`}
                  onClick={() => onPickRow({ leg, strike: r.strike, type })}
                >
                  <span className={styles.mStrike}>
                    <span className={`${styles.mono} ${styles.mStrikeVal}`}>{fmtStrike(r.strike)}</span>
                    <span className={`${styles.mono} ${styles.mIv}`}>IV {fmtIv(leg.iv)}</span>
                  </span>
                  <span className={`${styles.mono} ${styles.mNum} ${styles.down}`}>{fmtPrice(leg.bid)}</span>
                  <span className={`${styles.mono} ${styles.mNum} ${styles.up}`}>{fmtPrice(leg.ask)}</span>
                  <span className={`${styles.mono} ${styles.mDelta}`}>{fmtNum(leg.delta, 2)}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

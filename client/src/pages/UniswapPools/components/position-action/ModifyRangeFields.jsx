import { useState } from 'react';
import { formatUsd } from '../../utils/pool-formatters';
import { formatNumber } from '../../../../utils/formatters';
import { pctToPrice, priceToPct } from './form-state';
import styles from '../PositionActionModal.module.css';

/**
 * Sub-formulario del modal PositionActionModal específico para modificar el
 * rango de una posición V3/V4.
 *
 * Soporta dos modos:
 *   - "absolute": el usuario ingresa precios absolutos en token1/token0.
 *   - "percent":  el usuario ingresa porcentajes desde el precio actual.
 *
 * Ambos modos están sincronizados (al cambiar uno se actualiza el otro y el
 * `formState` que vive en el modal padre).
 */
export default function ModifyRangeFields({ pool, formState, setFormState }) {
  const priceCurrent = Number(pool?.priceCurrent || 0);
  const [mode, setMode] = useState('absolute');
  const [lowerPct, setLowerPct] = useState(() => {
    const p = Number(formState.rangeLowerPrice || 0);
    return p > 0 && priceCurrent > 0 ? priceToPct(priceCurrent, p).toFixed(2) : '-5';
  });
  const [upperPct, setUpperPct] = useState(() => {
    const p = Number(formState.rangeUpperPrice || 0);
    return p > 0 && priceCurrent > 0 ? priceToPct(priceCurrent, p).toFixed(2) : '5';
  });

  const lowerPrice = Number(formState.rangeLowerPrice || 0);
  const upperPrice = Number(formState.rangeUpperPrice || 0);
  const lowerPctDisplay = priceCurrent > 0 && lowerPrice > 0 ? priceToPct(priceCurrent, lowerPrice) : 0;
  const upperPctDisplay = priceCurrent > 0 && upperPrice > 0 ? priceToPct(priceCurrent, upperPrice) : 0;
  const rangeWidth = upperPrice > 0 && lowerPrice > 0 ? ((upperPrice - lowerPrice) / priceCurrent) * 100 : 0;

  const handleLowerPctChange = (event) => {
    const val = event.target.value;
    setLowerPct(val);
    const num = Number(val);
    if (Number.isFinite(num) && priceCurrent > 0) {
      setFormState((prev) => ({ ...prev, rangeLowerPrice: String(pctToPrice(priceCurrent, num).toFixed(6)) }));
    }
  };

  const handleUpperPctChange = (event) => {
    const val = event.target.value;
    setUpperPct(val);
    const num = Number(val);
    if (Number.isFinite(num) && priceCurrent > 0) {
      setFormState((prev) => ({ ...prev, rangeUpperPrice: String(pctToPrice(priceCurrent, num).toFixed(6)) }));
    }
  };

  const handleAbsoluteChange = (event) => {
    const { name, value } = event.target;
    setFormState((prev) => ({ ...prev, [name]: value }));
    const num = Number(value);
    if (Number.isFinite(num) && priceCurrent > 0) {
      if (name === 'rangeLowerPrice') setLowerPct(priceToPct(priceCurrent, num).toFixed(2));
      if (name === 'rangeUpperPrice') setUpperPct(priceToPct(priceCurrent, num).toFixed(2));
    }
  };

  const token0Symbol = pool?.token0?.symbol || 'Token0';
  const token1Symbol = pool?.token1?.symbol || 'Token1';
  const totalLpValue = Number(pool?.positionValueUsd || 0);
  const amount0 = Number(pool?.positionAmount0 || 0);
  const amount1 = Number(pool?.positionAmount1 || 0);

  return (
    <>
      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <span>Precio actual</span>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ color: '#66e1db', fontSize: '1.1rem' }}>
            {formatNumber(priceCurrent, 4)} {token1Symbol}/{token0Symbol}
          </strong>
          <span style={{ color: '#97a9bd', fontSize: '0.82rem' }}>
            LP: {formatNumber(amount0, 6)} {token0Symbol} + {formatNumber(amount1, 4)} {token1Symbol}
            {totalLpValue > 0 ? ` (${formatUsd(totalLpValue)})` : ''}
          </span>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={() => setMode('absolute')}
            style={{
              padding: '6px 14px', borderRadius: '8px', border: '1px solid',
              borderColor: mode === 'absolute' ? '#66e1db' : 'rgba(133,157,181,0.2)',
              background: mode === 'absolute' ? 'rgba(102,225,219,0.12)' : 'transparent',
              color: mode === 'absolute' ? '#66e1db' : '#97a9bd', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem',
            }}
          >
            Precio absoluto
          </button>
          <button
            type="button"
            onClick={() => setMode('percent')}
            style={{
              padding: '6px 14px', borderRadius: '8px', border: '1px solid',
              borderColor: mode === 'percent' ? '#66e1db' : 'rgba(133,157,181,0.2)',
              background: mode === 'percent' ? 'rgba(102,225,219,0.12)' : 'transparent',
              color: mode === 'percent' ? '#66e1db' : '#97a9bd', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem',
            }}
          >
            % desde precio actual
          </button>
        </div>
      </div>

      {mode === 'absolute' ? (
        <>
          <label className={styles.field}>
            <span>Precio inferior</span>
            <input name="rangeLowerPrice" value={formState.rangeLowerPrice} onChange={handleAbsoluteChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              {lowerPctDisplay >= 0 ? '+' : ''}{formatNumber(lowerPctDisplay, 2)}% desde actual
            </span>
          </label>
          <label className={styles.field}>
            <span>Precio superior</span>
            <input name="rangeUpperPrice" value={formState.rangeUpperPrice} onChange={handleAbsoluteChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              {upperPctDisplay >= 0 ? '+' : ''}{formatNumber(upperPctDisplay, 2)}% desde actual
            </span>
          </label>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span>Límite inferior (%)</span>
            <input type="number" step="0.1" value={lowerPct} onChange={handleLowerPctChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              = {formatNumber(Number(formState.rangeLowerPrice || 0), 4)} {token1Symbol}/{token0Symbol}
            </span>
          </label>
          <label className={styles.field}>
            <span>Límite superior (%)</span>
            <input type="number" step="0.1" value={upperPct} onChange={handleUpperPctChange} />
            <span style={{ color: '#97a9bd', fontSize: '0.75rem' }}>
              = {formatNumber(Number(formState.rangeUpperPrice || 0), 4)} {token1Symbol}/{token0Symbol}
            </span>
          </label>
        </>
      )}

      {lowerPrice > 0 && upperPrice > 0 && priceCurrent > 0 && (
        <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
          <span>Resumen del nuevo rango</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Ancho total</div>
              <strong style={{ color: '#f5f7fb' }}>{formatNumber(rangeWidth, 2)}%</strong>
            </div>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Inferior</div>
              <strong style={{ color: lowerPctDisplay < 0 ? '#ff7d7d' : '#3dd991' }}>
                {lowerPctDisplay >= 0 ? '+' : ''}{formatNumber(lowerPctDisplay, 2)}%
              </strong>
            </div>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Superior</div>
              <strong style={{ color: upperPctDisplay > 0 ? '#3dd991' : '#ff7d7d' }}>
                {upperPctDisplay >= 0 ? '+' : ''}{formatNumber(upperPctDisplay, 2)}%
              </strong>
            </div>
            <div style={{ background: 'rgba(102,225,219,0.06)', padding: '8px 12px', borderRadius: '10px' }}>
              <div style={{ color: '#97a9bd', fontSize: '0.72rem', textTransform: 'uppercase' }}>Centrado</div>
              <strong style={{ color: '#f5f7fb' }}>
                {priceCurrent >= lowerPrice && priceCurrent <= upperPrice ? 'Dentro' : 'Fuera'}
              </strong>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

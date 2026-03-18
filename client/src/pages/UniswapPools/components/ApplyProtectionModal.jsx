import { useState, useEffect } from 'react';
import { formatNumber } from '../../../utils/formatters';
import { formatAccountIdentity } from '../../../utils/hyperliquidAccounts';
import { formatUsd, formatCompactPrice, formatPercentRatio, roundUsd } from '../utils/pool-formatters';
import RangeTrack from './RangeTrack';
import styles from './ApplyProtectionModal.module.css';

const SHORTCUT_MULTIPLIERS = [1.25, 1.5, 2, 3, 4];
const STOP_LOSS_DIFFERENCE_DEFAULT_PCT = 0.05;

export default function ApplyProtectionModal({ pool, accounts, isSubmitting, onClose, onSubmit }) {
  const candidate = pool?.protectionCandidate;
  const defaultAccount = accounts.find((a) => a.isDefault) || accounts[0] || null;
  const [selectedAccountId, setSelectedAccountId] = useState(defaultAccount?.id ? String(defaultAccount.id) : '');
  const [leverage, setLeverage] = useState(String(candidate?.defaultLeverage || 10));
  const [configuredNotionalUsd, setConfiguredNotionalUsd] = useState(String(candidate?.suggestedNotionalUsd || candidate?.baseNotionalUsd || ''));
  const [stopLossDifferencePct, setStopLossDifferencePct] = useState(String(candidate?.stopLossDifferenceDefaultPct ?? STOP_LOSS_DIFFERENCE_DEFAULT_PCT));
  const [selectedMultiplier, setSelectedMultiplier] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelectedAccountId(defaultAccount?.id ? String(defaultAccount.id) : '');
    setLeverage(String(candidate?.defaultLeverage || 10));
    setConfiguredNotionalUsd(String(candidate?.suggestedNotionalUsd || candidate?.baseNotionalUsd || ''));
    setStopLossDifferencePct(String(candidate?.stopLossDifferenceDefaultPct ?? STOP_LOSS_DIFFERENCE_DEFAULT_PCT));
    setSelectedMultiplier(null);
    setError('');
  }, [pool, defaultAccount, candidate?.defaultLeverage, candidate?.suggestedNotionalUsd, candidate?.baseNotionalUsd, candidate?.stopLossDifferenceDefaultPct]);

  if (!pool || !candidate) return null;

  const maxLeverage = Number(candidate.maxLeverage || 1);
  const parsedNotionalUsd = Number(configuredNotionalUsd);
  const parsedStopLossDifferencePct = Number(stopLossDifferencePct);
  const estimatedSize = Number.isFinite(parsedNotionalUsd) && parsedNotionalUsd > 0 && Number(candidate.midPrice) > 0
    ? parsedNotionalUsd / Number(candidate.midPrice)
    : null;
  const downsideStopLoss = Number.isFinite(parsedStopLossDifferencePct) && parsedStopLossDifferencePct > 0 && parsedStopLossDifferencePct < 1
    ? Number(pool.rangeLowerPrice) * (1 + parsedStopLossDifferencePct)
    : null;
  const upsideStopLoss = Number.isFinite(parsedStopLossDifferencePct) && parsedStopLossDifferencePct > 0 && parsedStopLossDifferencePct < 1
    ? Number(pool.rangeUpperPrice) * (1 - parsedStopLossDifferencePct)
    : null;

  const applyMultiplier = (multiplier) => {
    const nextNotional = roundUsd(Number(candidate.baseNotionalUsd || 0) * multiplier);
    setSelectedMultiplier(multiplier);
    setConfiguredNotionalUsd(String(nextNotional));
    setError('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const parsedAccountId = Number(selectedAccountId);
    const parsedLeverage = Number(leverage);
    const normalizedNotionalUsd = Number(configuredNotionalUsd);

    if (!Number.isInteger(parsedAccountId) || parsedAccountId < 1) {
      setError('Selecciona una cuenta de Hyperliquid.');
      return;
    }
    if (!Number.isInteger(parsedLeverage) || parsedLeverage < 1 || parsedLeverage > maxLeverage) {
      setError(`El leverage debe estar entre 1x y ${maxLeverage}x para ${candidate.inferredAsset}.`);
      return;
    }
    if (!Number.isFinite(normalizedNotionalUsd) || normalizedNotionalUsd <= 0) {
      setError('El valor de proteccion debe ser un numero positivo en USD.');
      return;
    }
    if (!Number.isFinite(parsedStopLossDifferencePct) || parsedStopLossDifferencePct <= 0 || parsedStopLossDifferencePct >= 1) {
      setError('La diferencia de SL debe ser un decimal mayor que 0 y menor que 1. Ejemplo: 0.05 = 5%.');
      return;
    }

    setError('');
    await onSubmit({
      pool,
      accountId: parsedAccountId,
      leverage: parsedLeverage,
      configuredNotionalUsd: roundUsd(normalizedNotionalUsd),
      valueMultiplier: selectedMultiplier,
      stopLossDifferencePct: parsedStopLossDifferencePct,
    });
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <form
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-label="Aplicar proteccion al pool"
      >
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Configuracion de cobertura</span>
            <h2 className={styles.title}>Aplicar cobertura al pool</h2>
            <p className={styles.desc}>
              Se crearan dos coberturas ligadas al rango: una SHORT para ruptura por abajo y una LONG para ruptura por arriba.
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Cerrar">✕</button>
        </div>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.kicker}>Resumen del pool</span>
            <span className={styles.miniMeta}>{pool.inRange ? 'Dentro de rango' : 'Fuera de rango'}</span>
          </div>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryTile}><span className={styles.tileLabel}>Pool</span><strong className={styles.tileValue}>{pool.token0.symbol} / {pool.token1.symbol}</strong></div>
            <div className={styles.summaryTile}><span className={styles.tileLabel}>Activo HL</span><strong className={styles.tileValue}>{candidate.inferredAsset}</strong></div>
            <div className={styles.summaryTile}><span className={styles.tileLabel}>Valor base LP</span><strong className={styles.tileValue}>{formatUsd(candidate.baseNotionalUsd)}</strong></div>
            <div className={styles.summaryTile}><span className={styles.tileLabel}>Tamano estimado</span><strong className={styles.tileValue}>{estimatedSize != null ? `${formatNumber(estimatedSize, 6)} ${candidate.inferredAsset}` : '—'}</strong></div>
          </div>
        </section>

        <div className={styles.columns}>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Configuracion de cobertura</span>
              <span className={styles.miniMeta}>Maximo {maxLeverage}x</span>
            </div>

            <div className={styles.fieldGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Cuenta HL</span>
                <select className={styles.select} value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)}>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>{formatAccountIdentity(account)}</option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Leverage</span>
                <input className={styles.input} type="number" min="1" max={maxLeverage} step="1" value={leverage} onChange={(e) => setLeverage(e.target.value)} />
                <span className={styles.hint}>Default 10x isolated.</span>
              </label>

              <label className={`${styles.field} ${styles.fieldWide}`}>
                <span className={styles.fieldLabel}>Valor de proteccion (USD)</span>
                <input className={styles.input} type="number" min="0.01" step="0.01" value={configuredNotionalUsd} onChange={(e) => { setConfiguredNotionalUsd(e.target.value); setSelectedMultiplier(null); }} />
                <span className={styles.hint}>Cada cobertura se crea con este notional convertido al activo HL.</span>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Diferencia SL</span>
                <input className={styles.input} type="number" min="0.001" max="0.99" step="0.001" value={stopLossDifferencePct} onChange={(e) => setStopLossDifferencePct(e.target.value)} />
                <span className={styles.hint}>0.05 = 5% desde la entrada.</span>
              </label>
            </div>

            <div className={styles.multiplierBlock}>
              <span className={styles.fieldLabel}>Atajos multiplicadores</span>
              <div className={styles.multiplierBtns}>
                {SHORTCUT_MULTIPLIERS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`${styles.multiplierBtn} ${selectedMultiplier === m ? styles.multiplierBtnActive : ''}`}
                    onClick={() => applyMultiplier(m)}
                  >
                    {m}x
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className={`${styles.section} ${styles.sectionPreview}`}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Resultado estimado</span>
              <span className={styles.miniMeta}>{formatPercentRatio(parsedStopLossDifferencePct)}</span>
            </div>

            <div className={styles.previewStack}>
              <div className={styles.previewCard}><span className={styles.previewLabel}>Notional configurado</span><strong className={styles.previewValue}>{formatUsd(parsedNotionalUsd)}</strong></div>
              <div className={styles.previewCard}><span className={styles.previewLabel}>Tamano por cobertura</span><strong className={styles.previewValue}>{estimatedSize != null ? `${formatNumber(estimatedSize, 6)} ${candidate.inferredAsset}` : '—'}</strong></div>
              <div className={styles.previewCard}><span className={styles.previewLabel}>SHORT de defensa</span><strong className={styles.previewValue}>Entra {formatCompactPrice(pool.rangeLowerPrice)} · SL {formatCompactPrice(downsideStopLoss)}</strong></div>
              <div className={styles.previewCard}><span className={styles.previewLabel}>LONG de defensa</span><strong className={styles.previewValue}>Entra {formatCompactPrice(pool.rangeUpperPrice)} · SL {formatCompactPrice(upsideStopLoss)}</strong></div>
            </div>

            <RangeTrack pool={pool} compact />
          </section>
        </div>

        {error && <div className={styles.inlineError}>{error}</div>}

        <div className={styles.actions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Cancelar</button>
          <button type="submit" className={styles.primaryBtn} disabled={isSubmitting}>
            {isSubmitting ? 'Aplicando...' : 'Aplicar cobertura'}
          </button>
        </div>
      </form>
    </div>
  );
}

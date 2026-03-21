import { useState, useEffect } from 'react';
import { formatNumber } from '../../../utils/formatters';
import { formatAccountIdentity } from '../../../utils/hyperliquidAccounts';
import { formatUsd, formatCompactPrice, formatPercentRatio, roundUsd } from '../utils/pool-formatters';
import RangeTrack from './RangeTrack';
import styles from './ApplyProtectionModal.module.css';

const SHORTCUT_MULTIPLIERS = [1.25, 1.5, 2, 3, 4];
const STOP_LOSS_DIFFERENCE_DEFAULT_PCT = 0.05;
const DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT = 0.01;
const DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC = 15;
const DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT = 6;
const DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT = 0.5;
const DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC = 600;

function formatPercentInputValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return String(Number((parsed * 100).toFixed(6)));
}

export default function ApplyProtectionModal({ pool, accounts, isSubmitting, onClose, onSubmit }) {
  const candidate = pool?.protectionCandidate;
  const defaultAccount = accounts.find((a) => a.isDefault) || accounts[0] || null;
  const [selectedAccountId, setSelectedAccountId] = useState(defaultAccount?.id ? String(defaultAccount.id) : '');
  const [leverage, setLeverage] = useState(String(candidate?.defaultLeverage || 10));
  const [configuredNotionalUsd, setConfiguredNotionalUsd] = useState(String(candidate?.suggestedNotionalUsd || candidate?.baseNotionalUsd || ''));
  const [stopLossDifferencePct, setStopLossDifferencePct] = useState(String(candidate?.stopLossDifferenceDefaultPct ?? STOP_LOSS_DIFFERENCE_DEFAULT_PCT));
  const [protectionMode, setProtectionMode] = useState('static');
  const [reentryBufferPct, setReentryBufferPct] = useState(formatPercentInputValue(candidate?.reentryBufferPct ?? DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT));
  const [flipCooldownSec, setFlipCooldownSec] = useState(String(candidate?.flipCooldownSec ?? DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC));
  const [maxSequentialFlips, setMaxSequentialFlips] = useState(String(candidate?.maxSequentialFlips ?? DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT));
  const [breakoutConfirmDistancePct, setBreakoutConfirmDistancePct] = useState(String(candidate?.breakoutConfirmDistancePct ?? DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT));
  const [breakoutConfirmDurationSec, setBreakoutConfirmDurationSec] = useState(String(candidate?.breakoutConfirmDurationSec ?? DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC));
  const [selectedMultiplier, setSelectedMultiplier] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelectedAccountId(defaultAccount?.id ? String(defaultAccount.id) : '');
    setLeverage(String(candidate?.defaultLeverage || 10));
    setConfiguredNotionalUsd(String(candidate?.suggestedNotionalUsd || candidate?.baseNotionalUsd || ''));
    setStopLossDifferencePct(String(candidate?.stopLossDifferenceDefaultPct ?? STOP_LOSS_DIFFERENCE_DEFAULT_PCT));
    setProtectionMode('static');
    setReentryBufferPct(formatPercentInputValue(candidate?.reentryBufferPct ?? DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT));
    setFlipCooldownSec(String(candidate?.flipCooldownSec ?? DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC));
    setMaxSequentialFlips(String(candidate?.maxSequentialFlips ?? DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT));
    setBreakoutConfirmDistancePct(String(candidate?.breakoutConfirmDistancePct ?? DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT));
    setBreakoutConfirmDurationSec(String(candidate?.breakoutConfirmDurationSec ?? DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC));
    setSelectedMultiplier(null);
    setError('');
  }, [pool, defaultAccount, candidate?.defaultLeverage, candidate?.suggestedNotionalUsd, candidate?.baseNotionalUsd, candidate?.stopLossDifferenceDefaultPct, candidate?.reentryBufferPct, candidate?.flipCooldownSec, candidate?.maxSequentialFlips, candidate?.breakoutConfirmDistancePct, candidate?.breakoutConfirmDurationSec]);

  if (!pool || !candidate) return null;

  const maxLeverage = Number(candidate.maxLeverage || 1);
  const parsedNotionalUsd = Number(configuredNotionalUsd);
  const parsedStopLossDifferencePct = Number(stopLossDifferencePct);
  const parsedReentryBufferPctInput = Number(reentryBufferPct);
  const parsedReentryBufferPct = parsedReentryBufferPctInput / 100;
  const parsedFlipCooldownSec = Number(flipCooldownSec);
  const parsedMaxSequentialFlips = Number(maxSequentialFlips);
  const parsedBreakoutConfirmDistancePct = Number(breakoutConfirmDistancePct);
  const parsedBreakoutConfirmDurationSec = Number(breakoutConfirmDurationSec);
  const isDynamic = protectionMode === 'dynamic';
  const estimatedSize = Number.isFinite(parsedNotionalUsd) && parsedNotionalUsd > 0 && Number(candidate.midPrice) > 0
    ? parsedNotionalUsd / Number(candidate.midPrice)
    : null;
  const stopLossRatio = parsedStopLossDifferencePct / 100;
  const downsideStopLoss = Number.isFinite(parsedStopLossDifferencePct) && parsedStopLossDifferencePct > 0 && parsedStopLossDifferencePct < 100
    ? Number(pool.rangeLowerPrice) * (1 + stopLossRatio)
    : null;
  const upsideStopLoss = Number.isFinite(parsedStopLossDifferencePct) && parsedStopLossDifferencePct > 0 && parsedStopLossDifferencePct < 100
    ? Number(pool.rangeUpperPrice) * (1 - stopLossRatio)
    : null;
  const upperReentry = isDynamic && Number.isFinite(parsedReentryBufferPct) && parsedReentryBufferPct > 0 && parsedReentryBufferPct < 1
    ? Number(pool.rangeUpperPrice) * (1 - parsedReentryBufferPct)
    : null;
  const lowerReentry = isDynamic && Number.isFinite(parsedReentryBufferPct) && parsedReentryBufferPct > 0 && parsedReentryBufferPct < 1
    ? Number(pool.rangeLowerPrice) * (1 + parsedReentryBufferPct)
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
    if (!Number.isFinite(parsedStopLossDifferencePct) || parsedStopLossDifferencePct <= 0 || parsedStopLossDifferencePct >= 100) {
      setError('La diferencia de SL debe ser un porcentaje mayor que 0 y menor que 100. Ejemplo: 0.05 = 0.05%.');
      return;
    }
    if (isDynamic && (!Number.isFinite(parsedReentryBufferPctInput) || parsedReentryBufferPctInput <= 0 || parsedReentryBufferPctInput >= 100)) {
      setError('La separacion de reentrada debe ser un porcentaje mayor que 0 y menor que 100. Ejemplo: 1 = 1%.');
      return;
    }
    if (isDynamic && (!Number.isInteger(parsedFlipCooldownSec) || parsedFlipCooldownSec < 0)) {
      setError('El cooldown debe ser un entero mayor o igual a 0.');
      return;
    }
    if (isDynamic && (!Number.isInteger(parsedMaxSequentialFlips) || parsedMaxSequentialFlips < 1)) {
      setError('El maximo de flips debe ser un entero positivo.');
      return;
    }
    if (isDynamic && (!Number.isFinite(parsedBreakoutConfirmDistancePct) || parsedBreakoutConfirmDistancePct < 0 || parsedBreakoutConfirmDistancePct >= 100)) {
      setError('La distancia de confirmacion debe ser un porcentaje entre 0 y menor que 100. Ejemplo: 0.5 = 0.5%.');
      return;
    }
    if (isDynamic && (!Number.isInteger(parsedBreakoutConfirmDurationSec) || parsedBreakoutConfirmDurationSec < 0)) {
      setError('La duracion de confirmacion debe ser un entero mayor o igual a 0 segundos.');
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
      protectionMode,
      reentryBufferPct: isDynamic ? parsedReentryBufferPct : undefined,
      flipCooldownSec: isDynamic ? parsedFlipCooldownSec : undefined,
      maxSequentialFlips: isDynamic ? parsedMaxSequentialFlips : undefined,
      breakoutConfirmDistancePct: isDynamic ? parsedBreakoutConfirmDistancePct : undefined,
      breakoutConfirmDurationSec: isDynamic ? parsedBreakoutConfirmDurationSec : undefined,
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
              {isDynamic
                ? 'La proteccion dinamica mantiene la cobertura del breakout y mueve la cobertura opuesta para monetizar el reingreso al rango.'
                : 'Se crearan dos coberturas ligadas al rango: una SHORT para ruptura por abajo y una LONG para ruptura por arriba.'}
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
                <span className={styles.fieldLabel}>Modo</span>
                <select className={styles.select} value={protectionMode} onChange={(e) => setProtectionMode(e.target.value)}>
                  <option value="static">Proteccion normal</option>
                  <option value="dynamic">Proteccion dinamica</option>
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
                <input className={styles.input} type="number" min="0.001" max="99.99" step="0.001" value={stopLossDifferencePct} onChange={(e) => setStopLossDifferencePct(e.target.value)} />
                <span className={styles.hint}>{isDynamic ? 'En dinamica actua como SL de emergencia. 0.05 = 0.05%.' : 'El valor ya esta en porcentaje. 0.05 = 0.05% desde la entrada.'}</span>
              </label>

              {isDynamic && (
                <>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Separacion reentrada</span>
                    <input className={styles.input} type="number" min="0.001" max="99.99" step="0.001" value={reentryBufferPct} onChange={(e) => setReentryBufferPct(e.target.value)} />
                    <span className={styles.hint}>El valor ya esta en porcentaje. 1 = 1% hacia dentro del rango.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Cooldown flips</span>
                    <input className={styles.input} type="number" min="0" step="1" value={flipCooldownSec} onChange={(e) => setFlipCooldownSec(e.target.value)} />
                    <span className={styles.hint}>Evita rearmes duplicados por ruido.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Max flips seguidos</span>
                    <input className={styles.input} type="number" min="1" step="1" value={maxSequentialFlips} onChange={(e) => setMaxSequentialFlips(e.target.value)} />
                    <span className={styles.hint}>Si se excede, la dinamica se pausa.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Distancia confirmacion breakout</span>
                    <input className={styles.input} type="number" min="0" max="99.99" step="0.01" value={breakoutConfirmDistancePct} onChange={(e) => setBreakoutConfirmDistancePct(e.target.value)} />
                    <span className={styles.hint}>0.5 = 0.5% fuera del limite antes de desplazar el rango.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Duracion confirmacion breakout</span>
                    <input className={styles.input} type="number" min="0" step="1" value={breakoutConfirmDurationSec} onChange={(e) => setBreakoutConfirmDurationSec(e.target.value)} />
                    <span className={styles.hint}>600 = 10 min continuos fuera de rango para confirmar.</span>
                  </label>
                </>
              )}
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
              {isDynamic && (
                <>
                  <div className={styles.previewCard}><span className={styles.previewLabel}>Reentrada alta</span><strong className={styles.previewValue}>SHORT espera en {formatCompactPrice(upperReentry)} y el LONG protege hasta {formatCompactPrice(upperReentry)}</strong></div>
                  <div className={styles.previewCard}><span className={styles.previewLabel}>Reentrada baja</span><strong className={styles.previewValue}>LONG espera en {formatCompactPrice(lowerReentry)} y el SHORT protege hasta {formatCompactPrice(lowerReentry)}</strong></div>
                  <div className={styles.previewCard}><span className={styles.previewLabel}>Confirmacion breakout</span><strong className={styles.previewValue}>{parsedBreakoutConfirmDistancePct}% y {parsedBreakoutConfirmDurationSec}s fuera de rango</strong></div>
                </>
              )}
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

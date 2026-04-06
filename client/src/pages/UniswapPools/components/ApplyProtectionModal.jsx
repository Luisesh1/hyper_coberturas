import { useState, useEffect } from 'react';
import { formatNumber } from '../../../utils/formatters';
import { formatAccountIdentity } from '../../../utils/hyperliquidAccounts';
import { formatUsd, formatCompactPrice, roundUsd } from '../utils/pool-formatters';
import RangeTrack from './RangeTrack';
import styles from './ApplyProtectionModal.module.css';

const SHORTCUT_MULTIPLIERS = [1.25, 1.5, 2, 3, 4];
const STOP_LOSS_DIFFERENCE_DEFAULT_PCT = 0.05;
const DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT = 0.01;
const DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC = 15;
const DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT = 6;
const DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT = 0.5;
const DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC = 600;
const DELTA_NEUTRAL_DEFAULT_TARGET_HEDGE_RATIO = 1;
const DELTA_NEUTRAL_DEFAULT_MIN_REBALANCE_NOTIONAL_USD = 50;
const DELTA_NEUTRAL_DEFAULT_MAX_SLIPPAGE_BPS = 20;
const DELTA_NEUTRAL_DEFAULT_TWAP_MIN_NOTIONAL_USD = 10000;
const DELTA_NEUTRAL_PRESETS = [
  { id: 'adaptive', label: 'Adaptive', bandMode: 'adaptive', baseRebalancePriceMovePct: 3, rebalanceIntervalSec: 21600, annualCostHint: 'Coste intermedio con bandas adaptativas por volatilidad.' },
  { id: 'balanced', label: 'Balanced', bandMode: 'fixed', baseRebalancePriceMovePct: 3, rebalanceIntervalSec: 21600, annualCostHint: 'Perfil medio de seguimiento y comisiones.' },
  { id: 'aggressive', label: 'Aggressive', bandMode: 'fixed', baseRebalancePriceMovePct: 1, rebalanceIntervalSec: 3600, annualCostHint: 'Mas seguimiento del delta, mas coste de ejecucion.' },
  { id: 'conservative', label: 'Conservative', bandMode: 'fixed', baseRebalancePriceMovePct: 5, rebalanceIntervalSec: 43200, annualCostHint: 'Menos rebalanceo, mas drift tolerado.' },
];

function formatPercentInputValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return String(Number((parsed * 100).toFixed(6)));
}

function getEstimatedSize(candidate, protectionMode, parsedNotionalUsd) {
  if (protectionMode === 'delta_neutral') {
    const parsed = Number(candidate?.estimatedInitialHedgeQty);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return Number.isFinite(parsedNotionalUsd) && parsedNotionalUsd > 0 && Number(candidate?.midPrice) > 0
    ? parsedNotionalUsd / Number(candidate.midPrice)
    : null;
}

function buildInitialFormState(candidate, defaultAccount) {
  return {
    selectedAccountId: defaultAccount?.id ? String(defaultAccount.id) : '',
    leverage: String(candidate?.defaultLeverage || 10),
    configuredNotionalUsd: String(candidate?.suggestedNotionalUsd || candidate?.baseNotionalUsd || ''),
    stopLossDifferencePct: String(candidate?.stopLossDifferenceDefaultPct ?? STOP_LOSS_DIFFERENCE_DEFAULT_PCT),
    protectionMode: 'static',
    reentryBufferPct: formatPercentInputValue(candidate?.reentryBufferPct ?? DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT),
    flipCooldownSec: String(candidate?.flipCooldownSec ?? DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC),
    maxSequentialFlips: String(candidate?.maxSequentialFlips ?? DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT),
    breakoutConfirmDistancePct: String(candidate?.breakoutConfirmDistancePct ?? DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT),
    breakoutConfirmDurationSec: String(candidate?.breakoutConfirmDurationSec ?? DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC),
    bandMode: candidate?.bandMode || 'adaptive',
    baseRebalancePriceMovePct: String(candidate?.baseRebalancePriceMovePct ?? 3),
    rebalanceIntervalSec: String(candidate?.rebalanceIntervalSec ?? 21600),
    targetHedgeRatio: String(candidate?.targetHedgeRatio ?? DELTA_NEUTRAL_DEFAULT_TARGET_HEDGE_RATIO),
    minRebalanceNotionalUsd: String(candidate?.minRebalanceNotionalUsd ?? DELTA_NEUTRAL_DEFAULT_MIN_REBALANCE_NOTIONAL_USD),
    maxSlippageBps: String(candidate?.maxSlippageBps ?? DELTA_NEUTRAL_DEFAULT_MAX_SLIPPAGE_BPS),
    twapMinNotionalUsd: String(candidate?.twapMinNotionalUsd ?? DELTA_NEUTRAL_DEFAULT_TWAP_MIN_NOTIONAL_USD),
    selectedDeltaPreset: 'adaptive',
    selectedMultiplier: null,
  };
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
  const [bandMode, setBandMode] = useState(candidate?.bandMode || 'adaptive');
  const [baseRebalancePriceMovePct, setBaseRebalancePriceMovePct] = useState(String(candidate?.baseRebalancePriceMovePct ?? 3));
  const [rebalanceIntervalSec, setRebalanceIntervalSec] = useState(String(candidate?.rebalanceIntervalSec ?? 21600));
  const [targetHedgeRatio, setTargetHedgeRatio] = useState(String(candidate?.targetHedgeRatio ?? DELTA_NEUTRAL_DEFAULT_TARGET_HEDGE_RATIO));
  const [minRebalanceNotionalUsd, setMinRebalanceNotionalUsd] = useState(String(candidate?.minRebalanceNotionalUsd ?? DELTA_NEUTRAL_DEFAULT_MIN_REBALANCE_NOTIONAL_USD));
  const [maxSlippageBps, setMaxSlippageBps] = useState(String(candidate?.maxSlippageBps ?? DELTA_NEUTRAL_DEFAULT_MAX_SLIPPAGE_BPS));
  const [twapMinNotionalUsd, setTwapMinNotionalUsd] = useState(String(candidate?.twapMinNotionalUsd ?? DELTA_NEUTRAL_DEFAULT_TWAP_MIN_NOTIONAL_USD));
  const [selectedDeltaPreset, setSelectedDeltaPreset] = useState('adaptive');
  const [selectedMultiplier, setSelectedMultiplier] = useState(null);
  const [error, setError] = useState('');

  // Reset form state when the pool identity changes (a different pool was selected).
  // We only depend on pool.id to avoid re-resetting on every minor candidate update.
  useEffect(() => {
    const initial = buildInitialFormState(candidate, defaultAccount);
    setSelectedAccountId(initial.selectedAccountId);
    setLeverage(initial.leverage);
    setConfiguredNotionalUsd(initial.configuredNotionalUsd);
    setStopLossDifferencePct(initial.stopLossDifferencePct);
    setProtectionMode(initial.protectionMode);
    setReentryBufferPct(initial.reentryBufferPct);
    setFlipCooldownSec(initial.flipCooldownSec);
    setMaxSequentialFlips(initial.maxSequentialFlips);
    setBreakoutConfirmDistancePct(initial.breakoutConfirmDistancePct);
    setBreakoutConfirmDurationSec(initial.breakoutConfirmDurationSec);
    setBandMode(initial.bandMode);
    setBaseRebalancePriceMovePct(initial.baseRebalancePriceMovePct);
    setRebalanceIntervalSec(initial.rebalanceIntervalSec);
    setTargetHedgeRatio(initial.targetHedgeRatio);
    setMinRebalanceNotionalUsd(initial.minRebalanceNotionalUsd);
    setMaxSlippageBps(initial.maxSlippageBps);
    setTwapMinNotionalUsd(initial.twapMinNotionalUsd);
    setSelectedDeltaPreset(initial.selectedDeltaPreset);
    setSelectedMultiplier(initial.selectedMultiplier);
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool?.id, defaultAccount?.id]);

  if (!pool || !candidate) return null;

  const isDynamic = protectionMode === 'dynamic';
  const isDeltaNeutral = protectionMode === 'delta_neutral';
  const maxLeverage = Number(candidate.maxLeverage || 1);
  const parsedNotionalUsd = Number(configuredNotionalUsd);
  const parsedStopLossDifferencePct = Number(stopLossDifferencePct);
  const parsedReentryBufferPctInput = Number(reentryBufferPct);
  const parsedReentryBufferPct = parsedReentryBufferPctInput / 100;
  const parsedFlipCooldownSec = Number(flipCooldownSec);
  const parsedMaxSequentialFlips = Number(maxSequentialFlips);
  const parsedBreakoutConfirmDistancePct = Number(breakoutConfirmDistancePct);
  const parsedBreakoutConfirmDurationSec = Number(breakoutConfirmDurationSec);
  const parsedBaseRebalancePriceMovePct = Number(baseRebalancePriceMovePct);
  const parsedRebalanceIntervalSec = Number(rebalanceIntervalSec);
  const parsedTargetHedgeRatio = Number(targetHedgeRatio);
  const parsedMinRebalanceNotionalUsd = Number(minRebalanceNotionalUsd);
  const parsedMaxSlippageBps = Number(maxSlippageBps);
  const parsedTwapMinNotionalUsd = Number(twapMinNotionalUsd);
  const estimatedSize = getEstimatedSize(candidate, protectionMode, parsedNotionalUsd);
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

  const applyDeltaPreset = (preset) => {
    setSelectedDeltaPreset(preset.id);
    setBandMode(preset.bandMode);
    setBaseRebalancePriceMovePct(String(preset.baseRebalancePriceMovePct));
    setRebalanceIntervalSec(String(preset.rebalanceIntervalSec));
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
    if (!isDeltaNeutral && (!Number.isFinite(parsedStopLossDifferencePct) || parsedStopLossDifferencePct <= 0 || parsedStopLossDifferencePct >= 100)) {
      setError('La diferencia de SL debe ser un porcentaje mayor que 0 y menor que 100. Ejemplo: 0.05 = 0.05%.');
      return;
    }
    if (isDeltaNeutral && !candidate.deltaNeutralEligible) {
      setError(candidate.deltaNeutralReason || 'Este pool no es elegible para delta-neutral.');
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
    if (isDeltaNeutral && (!Number.isFinite(parsedBaseRebalancePriceMovePct) || parsedBaseRebalancePriceMovePct <= 0 || parsedBaseRebalancePriceMovePct >= 100)) {
      setError('La banda base debe ser un porcentaje mayor que 0 y menor que 100.');
      return;
    }
    if (isDeltaNeutral && (!Number.isInteger(parsedRebalanceIntervalSec) || parsedRebalanceIntervalSec < 60)) {
      setError('El intervalo de rebalance debe ser de al menos 60 segundos.');
      return;
    }
    if (isDeltaNeutral && (!Number.isFinite(parsedTargetHedgeRatio) || parsedTargetHedgeRatio <= 0 || parsedTargetHedgeRatio > 2)) {
      setError('El hedge ratio debe estar entre 0 y 2.');
      return;
    }
    if (isDeltaNeutral && (!Number.isFinite(parsedMinRebalanceNotionalUsd) || parsedMinRebalanceNotionalUsd <= 0)) {
      setError('El drift minimo debe ser un USD positivo.');
      return;
    }
    if (isDeltaNeutral && (!Number.isInteger(parsedMaxSlippageBps) || parsedMaxSlippageBps < 1 || parsedMaxSlippageBps > 500)) {
      setError('El slippage maximo debe estar entre 1 y 500 bps.');
      return;
    }
    if (isDeltaNeutral && (!Number.isFinite(parsedTwapMinNotionalUsd) || parsedTwapMinNotionalUsd <= 0)) {
      setError('El umbral de TWAP debe ser un USD positivo.');
      return;
    }

    setError('');
    await onSubmit({
      pool,
      accountId: parsedAccountId,
      leverage: parsedLeverage,
      configuredNotionalUsd: roundUsd(normalizedNotionalUsd),
      valueMultiplier: selectedMultiplier,
      stopLossDifferencePct: isDeltaNeutral ? undefined : parsedStopLossDifferencePct,
      protectionMode,
      reentryBufferPct: isDynamic ? parsedReentryBufferPct : undefined,
      flipCooldownSec: isDynamic ? parsedFlipCooldownSec : undefined,
      maxSequentialFlips: isDynamic ? parsedMaxSequentialFlips : undefined,
      breakoutConfirmDistancePct: isDynamic ? parsedBreakoutConfirmDistancePct : undefined,
      breakoutConfirmDurationSec: isDynamic ? parsedBreakoutConfirmDurationSec : undefined,
      bandMode: isDeltaNeutral ? bandMode : undefined,
      baseRebalancePriceMovePct: isDeltaNeutral ? parsedBaseRebalancePriceMovePct : undefined,
      rebalanceIntervalSec: isDeltaNeutral ? parsedRebalanceIntervalSec : undefined,
      targetHedgeRatio: isDeltaNeutral ? parsedTargetHedgeRatio : undefined,
      minRebalanceNotionalUsd: isDeltaNeutral ? parsedMinRebalanceNotionalUsd : undefined,
      maxSlippageBps: isDeltaNeutral ? parsedMaxSlippageBps : undefined,
      twapMinNotionalUsd: isDeltaNeutral ? parsedTwapMinNotionalUsd : undefined,
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
              {isDeltaNeutral
                ? 'Mantiene el LP intacto y ajusta un short en Hyperliquid usando delta efectivo del rango concentrado.'
                : isDynamic
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
            <div className={styles.summaryTile}><span className={styles.tileLabel}>{isDeltaNeutral ? 'Short inicial' : 'Tamano estimado'}</span><strong className={styles.tileValue}>{estimatedSize != null ? `${formatNumber(estimatedSize, 6)} ${candidate.inferredAsset}` : '—'}</strong></div>
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
                  <option value="delta_neutral" disabled={!candidate.deltaNeutralEligible}>Delta neutral</option>
                </select>
                {!candidate.deltaNeutralEligible && (
                  <span className={styles.hint}>{candidate.deltaNeutralReason || 'Delta neutral solo aplica a pools stable + 1 volatil.'}</span>
                )}
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Leverage</span>
                <input className={styles.input} type="number" min="1" max={maxLeverage} step="1" value={leverage} onChange={(e) => setLeverage(e.target.value)} />
                <span className={styles.hint}>Default 10x isolated.</span>
              </label>

              <label className={`${styles.field} ${styles.fieldWide}`}>
                <span className={styles.fieldLabel}>Valor de proteccion (USD)</span>
                <input className={styles.input} type="number" min="0.01" step="0.01" value={configuredNotionalUsd} onChange={(e) => { setConfiguredNotionalUsd(e.target.value); setSelectedMultiplier(null); }} />
                <span className={styles.hint}>{isDeltaNeutral ? 'Se usa como referencia fija para caps y reporting del overlay.' : 'Cada cobertura se crea con este notional convertido al activo HL.'}</span>
              </label>

              {!isDeltaNeutral && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Diferencia SL</span>
                  <input className={styles.input} type="number" min="0.001" max="99.99" step="0.001" value={stopLossDifferencePct} onChange={(e) => setStopLossDifferencePct(e.target.value)} />
                  <span className={styles.hint}>{isDynamic ? 'En dinamica actua como SL de emergencia. 0.05 = 0.05%.' : 'El valor ya esta en porcentaje. 0.05 = 0.05% desde la entrada.'}</span>
                </label>
              )}

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

              {isDeltaNeutral && (
                <>
                  <div className={`${styles.field} ${styles.fieldWide} ${styles.multiplierBlock}`}>
                    <span className={styles.fieldLabel}>Preset de rebalance</span>
                    <div className={styles.multiplierBtns}>
                      {DELTA_NEUTRAL_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className={`${styles.multiplierBtn} ${selectedDeltaPreset === preset.id ? styles.multiplierBtnActive : ''}`}
                          onClick={() => applyDeltaPreset(preset)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <span className={styles.hint}>
                      {DELTA_NEUTRAL_PRESETS.find((preset) => preset.id === selectedDeltaPreset)?.annualCostHint}
                    </span>
                  </div>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Band mode</span>
                    <select className={styles.select} value={bandMode} onChange={(e) => setBandMode(e.target.value)}>
                      <option value="adaptive">Adaptive</option>
                      <option value="fixed">Fixed</option>
                    </select>
                    <span className={styles.hint}>Adaptive usa max(rv4h, rv24h) para moverse entre 1/3/5%.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Banda base</span>
                    <input className={styles.input} type="number" min="0.1" max="99.99" step="0.1" value={baseRebalancePriceMovePct} onChange={(e) => setBaseRebalancePriceMovePct(e.target.value)} />
                    <span className={styles.hint}>Porcentaje de movimiento antes del trigger por precio.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Intervalo rebalance</span>
                    <input className={styles.input} type="number" min="60" step="60" value={rebalanceIntervalSec} onChange={(e) => setRebalanceIntervalSec(e.target.value)} />
                    <span className={styles.hint}>El timer solo actua si ademas el drift supera el minimo USD.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Hedge ratio</span>
                    <input className={styles.input} type="number" min="0.1" max="2" step="0.05" value={targetHedgeRatio} onChange={(e) => setTargetHedgeRatio(e.target.value)} />
                    <span className={styles.hint}>1.0 = cubrir el delta completo estimado del LP.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Drift minimo USD</span>
                    <input className={styles.input} type="number" min="1" step="1" value={minRebalanceNotionalUsd} onChange={(e) => setMinRebalanceNotionalUsd(e.target.value)} />
                    <span className={styles.hint}>Evita rebalances triviales cuando vence el timer.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Slippage max (bps)</span>
                    <input className={styles.input} type="number" min="1" max="500" step="1" value={maxSlippageBps} onChange={(e) => setMaxSlippageBps(e.target.value)} />
                    <span className={styles.hint}>Cap para IOC y fallback defensivo.</span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Umbral TWAP USD</span>
                    <input className={styles.input} type="number" min="100" step="100" value={twapMinNotionalUsd} onChange={(e) => setTwapMinNotionalUsd(e.target.value)} />
                    <span className={styles.hint}>Ajustes mas grandes se trocean en 5 slices/60s por defecto.</span>
                  </label>
                </>
              )}

              <div className={`${styles.field} ${styles.fieldWide} ${styles.multiplierBlock}`}>
                <span className={styles.fieldLabel}>Atajos de valor LP</span>
                <div className={styles.multiplierBtns}>
                  {SHORTCUT_MULTIPLIERS.map((multiplier) => (
                    <button
                      key={multiplier}
                      type="button"
                      className={`${styles.multiplierBtn} ${selectedMultiplier === multiplier ? styles.multiplierBtnActive : ''}`}
                      onClick={() => applyMultiplier(multiplier)}
                    >
                      {multiplier}x
                    </button>
                  ))}
                </div>
                <span className={styles.hint}>Sirve como referencia rapida para el notional protegido/reportado.</span>
              </div>
            </div>

            {error && <div className={styles.inlineError}>{error}</div>}

            <div className={styles.actions}>
              <button type="button" className={styles.ghostBtn} onClick={onClose}>Cancelar</button>
              <button type="submit" className={styles.primaryBtn} disabled={isSubmitting}>
                {isSubmitting
                  ? 'Aplicando...'
                  : isDeltaNeutral
                    ? 'Activar overlay delta-neutral'
                    : isDynamic
                      ? 'Activar proteccion dinamica'
                      : 'Activar cobertura de rango'}
              </button>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Vista previa</span>
              <span className={styles.miniMeta}>{candidate.inferredAsset}</span>
            </div>

            <div className={styles.previewStack}>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Notional seleccionado</span>
                <strong className={styles.tileValue}>{formatUsd(parsedNotionalUsd)}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>{isDeltaNeutral ? 'Short inicial estimado' : 'Tamano hedge'}</span>
                <strong className={styles.tileValue}>{estimatedSize != null ? `${formatNumber(estimatedSize, 6)} ${candidate.inferredAsset}` : '—'}</strong>
              </div>
              {isDeltaNeutral && (
                <>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Delta estimado</span>
                    <strong className={styles.tileValue}>{candidate.deltaQty != null ? formatNumber(candidate.deltaQty, 6) : '—'}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Gamma estimada</span>
                    <strong className={styles.tileValue}>{candidate.gamma != null ? formatNumber(candidate.gamma, 8) : '—'}</strong>
                  </div>
                </>
              )}
              {!isDeltaNeutral && (
                <>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>SL downside</span>
                    <strong className={styles.tileValue}>{formatCompactPrice(downsideStopLoss)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>SL upside</span>
                    <strong className={styles.tileValue}>{formatCompactPrice(upsideStopLoss)}</strong>
                  </div>
                </>
              )}
              {isDynamic && (
                <>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Reentrada superior</span>
                    <strong className={styles.tileValue}>{formatCompactPrice(upperReentry)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Reentrada inferior</span>
                    <strong className={styles.tileValue}>{formatCompactPrice(lowerReentry)}</strong>
                  </div>
                </>
              )}
            </div>

            {pool.mode === 'lp_position' && <RangeTrack pool={pool} compact showOpen={false} />}
          </section>
        </div>
      </form>
    </div>
  );
}

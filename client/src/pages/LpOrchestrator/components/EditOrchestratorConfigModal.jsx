import { useMemo, useState } from 'react';
import { lpOrchestratorApi } from '../../../services/api';
import ProtectionFormFields, {
  buildProtectionPayload,
  validateProtectionForm,
} from './ProtectionFormFields';
import styles from './CreateOrchestratorWizard.module.css';

// Convierte el `protectionConfig` persistido (forma payload/backend) al shape
// del form (strings para inputs). Si viene null/undefined, muestra la UI
// "desactivada" con los defaults de ProtectionFormFields.
function protectionConfigToFormValue(cfg) {
  if (!cfg || cfg.enabled === false) {
    return { enabled: false };
  }
  return {
    enabled: true,
    accountId: cfg.accountId ?? '',
    leverage: cfg.leverage != null ? String(cfg.leverage) : '5',
    configuredNotionalUsd: cfg.configuredNotionalUsd != null ? String(cfg.configuredNotionalUsd) : '',
    bandMode: cfg.bandMode || 'adaptive',
    baseRebalancePriceMovePct: cfg.baseRebalancePriceMovePct != null ? String(cfg.baseRebalancePriceMovePct) : '3',
    rebalanceIntervalSec: cfg.rebalanceIntervalSec != null ? String(cfg.rebalanceIntervalSec) : '21600',
    targetHedgeRatio: cfg.targetHedgeRatio != null ? String(cfg.targetHedgeRatio) : '1',
    minRebalanceNotionalUsd: cfg.minRebalanceNotionalUsd != null ? String(cfg.minRebalanceNotionalUsd) : '50',
    maxSlippageBps: cfg.maxSlippageBps != null ? String(cfg.maxSlippageBps) : '20',
    twapMinNotionalUsd: cfg.twapMinNotionalUsd != null ? String(cfg.twapMinNotionalUsd) : '10000',
    preset: 'adaptive',
    autoTunedFor: null,
  };
}

function strategyConfigToFormValue(cfg = {}) {
  return {
    rangeWidthPct: cfg.rangeWidthPct != null ? String(cfg.rangeWidthPct) : '5',
    edgeMarginPct: cfg.edgeMarginPct != null ? String(cfg.edgeMarginPct) : '40',
    costToRewardThreshold: cfg.costToRewardThreshold != null ? String(cfg.costToRewardThreshold) : '0.3333',
    minRebalanceCooldownSec: cfg.minRebalanceCooldownSec != null ? String(cfg.minRebalanceCooldownSec) : '3600',
    minNetLpEarningsForRebalanceUsd: cfg.minNetLpEarningsForRebalanceUsd != null ? String(cfg.minNetLpEarningsForRebalanceUsd) : '0',
    reinvestThresholdUsd: cfg.reinvestThresholdUsd != null ? String(cfg.reinvestThresholdUsd) : '10',
    urgentAlertRepeatMinutes: cfg.urgentAlertRepeatMinutes != null ? String(cfg.urgentAlertRepeatMinutes) : '30',
    maxSlippageBps: cfg.maxSlippageBps != null ? String(cfg.maxSlippageBps) : '100',
  };
}

export default function EditOrchestratorConfigModal({
  orchestrator,
  accounts = [],
  onClose,
  onSaved,
}) {
  const [strategy, setStrategy] = useState(() => strategyConfigToFormValue(orchestrator?.strategyConfig));
  const [protection, setProtection] = useState(() => protectionConfigToFormValue(orchestrator?.protectionConfig));
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const rw = Number(strategy.rangeWidthPct);
  const em = Number(strategy.edgeMarginPct);
  const centralPct = Number.isFinite(rw) && Number.isFinite(em) ? (100 - 2 * em) : null;

  const initialUsd = Number(orchestrator?.initialTotalUsd) || 0;
  const hasActiveProtectedPool = Boolean(orchestrator?.activeProtectedPoolId);

  const handleStrategyField = (key, value) => setStrategy((prev) => ({ ...prev, [key]: value }));

  function validate() {
    const rwNum = Number(strategy.rangeWidthPct);
    if (!Number.isFinite(rwNum) || rwNum <= 0 || rwNum >= 100) {
      return 'El ancho del rango debe estar entre 0 y 100%.';
    }
    const emNum = Number(strategy.edgeMarginPct);
    if (!Number.isFinite(emNum) || emNum < 5 || emNum > 49) {
      return 'El margen de borde debe estar entre 5% y 49%.';
    }
    const cr = Number(strategy.costToRewardThreshold);
    if (!Number.isFinite(cr) || cr <= 0 || cr >= 1) {
      return 'El umbral coste/recompensa debe estar entre 0 y 1.';
    }
    const cooldown = Number(strategy.minRebalanceCooldownSec);
    if (!Number.isFinite(cooldown) || cooldown < 0) {
      return 'El cooldown anti-thrashing debe ser ≥ 0.';
    }
    const alertMin = Number(strategy.urgentAlertRepeatMinutes);
    if (!Number.isFinite(alertMin) || alertMin < 1 || alertMin > 1440) {
      return 'La repetición de alerta urgente debe estar entre 1 y 1440 min.';
    }
    const slip = Number(strategy.maxSlippageBps);
    if (!Number.isFinite(slip) || slip < 1 || slip > 1000) {
      return 'El max slippage (bps) debe estar entre 1 y 1000.';
    }
    return validateProtectionForm(protection);
  }

  // Calcula qué campos de estrategia cambiaron respecto al persistido. Solo
  // esos van al PATCH para no pisar defaults con strings vacíos si el usuario
  // los borró accidentalmente.
  const strategyDiff = useMemo(() => {
    const original = orchestrator?.strategyConfig || {};
    const diff = {};
    const keys = [
      'rangeWidthPct', 'edgeMarginPct', 'costToRewardThreshold',
      'minRebalanceCooldownSec', 'minNetLpEarningsForRebalanceUsd',
      'reinvestThresholdUsd', 'urgentAlertRepeatMinutes', 'maxSlippageBps',
    ];
    for (const key of keys) {
      const parsed = Number(strategy[key]);
      if (!Number.isFinite(parsed)) continue;
      if (parsed !== Number(original[key])) diff[key] = parsed;
    }
    return diff;
  }, [strategy, orchestrator]);

  const protectionPayload = useMemo(() => buildProtectionPayload(protection), [protection]);
  // Solo mandamos protectionConfig si realmente hubo cambios — comparamos
  // contra el persistido (con enabled:false normalizado para null).
  const protectionChanged = useMemo(() => {
    const original = orchestrator?.protectionConfig;
    const wasEnabled = Boolean(original && original.enabled !== false);
    const nowEnabled = Boolean(protectionPayload.enabled);
    if (wasEnabled !== nowEnabled) return true;
    if (!nowEnabled) return false;
    const keys = Object.keys(protectionPayload);
    return keys.some((k) => protectionPayload[k] !== (original || {})[k]);
  }, [protectionPayload, orchestrator]);

  async function handleSave() {
    setError('');
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    if (!Object.keys(strategyDiff).length && !protectionChanged) {
      setError('No hay cambios que guardar.');
      return;
    }
    setIsBusy(true);
    try {
      const body = {};
      if (Object.keys(strategyDiff).length) body.strategyConfig = strategyDiff;
      if (protectionChanged) body.protectionConfig = protectionPayload;
      const updated = await lpOrchestratorApi.updateConfig(orchestrator.id, body);
      onSaved?.(updated);
      onClose?.();
    } catch (err) {
      setError(err.message || 'No se pudo guardar la configuración.');
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>LP Orchestrator</span>
            <h2 className={styles.title}>Editar configuración</h2>
            <p className={styles.stepLabel}>{orchestrator?.name || `#${orchestrator?.id}`}</p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose}>✕</button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle || ''} style={{ margin: '0 0 8px 0' }}>Estrategia</h3>

            <div className={styles.strategyPreview}>
              <div className={styles.previewBox}>
                <span className={styles.previewLabel}>Resumen</span>
                <div className={styles.previewBars}>
                  <div className={styles.previewBar}>
                    <div className={styles.previewEdge} style={{ flex: em || 0 }}>borde</div>
                    <div className={styles.previewCentral} style={{ flex: centralPct || 0 }}>
                      {centralPct != null ? `${centralPct}% central` : '—'}
                    </div>
                    <div className={styles.previewEdge} style={{ flex: em || 0 }}>borde</div>
                  </div>
                </div>
                <span className={styles.previewHint}>
                  ±{Number.isFinite(rw) ? rw : '?'}% del precio · {Number.isFinite(em) ? em : '?'}% margen a cada borde
                </span>
              </div>
            </div>

            <div className={styles.fields}>
              <div className={styles.row}>
                <div className={styles.field}>
                  <label>Ancho del rango (±%)</label>
                  <input
                    type="number" min="0.1" max="99" step="0.5"
                    value={strategy.rangeWidthPct}
                    onChange={(e) => handleStrategyField('rangeWidthPct', e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label>Margen de borde (%)</label>
                  <input
                    type="number" min="5" max="49" step="1"
                    value={strategy.edgeMarginPct}
                    onChange={(e) => handleStrategyField('edgeMarginPct', e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.row}>
                <div className={styles.field}>
                  <label>Umbral coste / recompensa</label>
                  <input
                    type="number" min="0.01" max="0.99" step="0.01"
                    value={strategy.costToRewardThreshold}
                    onChange={(e) => handleStrategyField('costToRewardThreshold', e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label>Umbral reinvest fees (USD)</label>
                  <input
                    type="number" min="0" step="1"
                    value={strategy.reinvestThresholdUsd}
                    onChange={(e) => handleStrategyField('reinvestThresholdUsd', e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.row}>
                <div className={styles.field}>
                  <label>Repetir alerta urgente cada (min)</label>
                  <input
                    type="number" min="1" max="1440" step="1"
                    value={strategy.urgentAlertRepeatMinutes}
                    onChange={(e) => handleStrategyField('urgentAlertRepeatMinutes', e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label>Cooldown anti-thrashing (s)</label>
                  <input
                    type="number" min="0" step="60"
                    value={strategy.minRebalanceCooldownSec}
                    onChange={(e) => handleStrategyField('minRebalanceCooldownSec', e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.row}>
                <div className={styles.field}>
                  <label>Min ganancias netas LP para rebalancear (USD)</label>
                  <input
                    type="number" min="0" step="1"
                    value={strategy.minNetLpEarningsForRebalanceUsd}
                    onChange={(e) => handleStrategyField('minNetLpEarningsForRebalanceUsd', e.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label>Max slippage swaps (bps)</label>
                  <input
                    type="number" min="1" max="1000" step="1"
                    value={strategy.maxSlippageBps}
                    onChange={(e) => handleStrategyField('maxSlippageBps', e.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <h3 style={{ margin: '16px 0 8px 0' }}>Protección delta-neutral</h3>
            {hasActiveProtectedPool && (
              <p className={styles.hint} style={{ marginBottom: 12 }}>
                Este orquestador tiene una protección activa. Los cambios aquí <strong>sólo afectan al próximo LP</strong>; la protección actual mantiene su configuración hasta que se cierre.
              </p>
            )}
            <ProtectionFormFields
              value={protection}
              onChange={setProtection}
              accounts={accounts}
              initialUsd={initialUsd}
              rangeWidthPct={Number(strategy.rangeWidthPct) || null}
            />
          </section>

          {error && <p className={styles.error}>{error}</p>}
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.btn} onClick={onClose} disabled={isBusy}>
            Cancelar
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={handleSave}
            disabled={isBusy}
          >
            {isBusy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </footer>
      </div>
    </div>
  );
}

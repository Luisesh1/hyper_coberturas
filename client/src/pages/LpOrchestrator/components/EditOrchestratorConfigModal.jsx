import { useMemo, useState } from 'react';
import { lpOrchestratorApi } from '../../../services/api';
import ProtectionFormFields, {
  buildProtectionPayload,
  validateProtectionForm,
  DEFAULT_CENTER_DEAD_ZONE_PCT,
} from '../../../features/lp-wizard/ProtectionFormFields';
import StrategyFieldInput from './StrategyFieldInput';
import { validateStrategyFields } from './strategy-fields';
import ModalShell from '../../../components/shared/ModalShell/ModalShell';
import ui from '../../../styles/modal-controls.module.css';
import styles from './EditOrchestratorConfigModal.module.css';

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
    minRebalanceNotionalPct: cfg.minRebalanceNotionalPct != null ? String(cfg.minRebalanceNotionalPct) : '12',
    centerDeadZonePct: cfg.centerDeadZonePct != null
      ? String(cfg.centerDeadZonePct)
      : String(DEFAULT_CENTER_DEAD_ZONE_PCT),
    maxSlippageBps: cfg.maxSlippageBps != null ? String(cfg.maxSlippageBps) : '20',
    twapMinNotionalUsd: cfg.twapMinNotionalUsd != null ? String(cfg.twapMinNotionalUsd) : '10000',
    // La politica tiene que viajar: sin esto el formulario abria en
    // `legacy_zones_v1` (el default) y guardar cualquier otro campo reescribia
    // la seleccion a legacy en silencio.
    policyVersion: cfg.policyVersion || 'legacy_zones_v1',
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

  // El LP vivo, para que la zona central sin rebalanceo pueda dibujar donde
  // esta el precio ahora mismo dentro del rango real.
  const livePool = orchestrator?.lastEvaluation?.poolSnapshot || null;
  const initialUsd = Number(orchestrator?.initialTotalUsd) || 0;
  const hasActiveProtectedPool = Boolean(orchestrator?.activeProtectedPoolId);

  const handleStrategyField = (key, value) => setStrategy((prev) => ({ ...prev, [key]: value }));

  function validate() {
    // Los rangos salen de la definicion compartida: antes este modal validaba
    // 6 campos y el wizard solo 3, sobre los mismos limites.
    return validateStrategyFields(strategy) || validateProtectionForm(protection);
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

  const STRATEGY_FIELDS = [
    'rangeWidthPct', 'edgeMarginPct',
    'costToRewardThreshold', 'reinvestThresholdUsd',
    'urgentAlertRepeatMinutes', 'minRebalanceCooldownSec',
    'minNetLpEarningsForRebalanceUsd', 'maxSlippageBps',
  ];

  return (
    <ModalShell
      eyebrow="LP Orchestrator"
      title="Editar configuración"
      desc={orchestrator?.name || `#${orchestrator?.id}`}
      size="md"
      onClose={onClose}
      closeDisabled={isBusy}
      footer={(
        <>
          <button type="button" className={ui.btnSecondary} onClick={onClose} disabled={isBusy}>
            Cancelar
          </button>
          <button type="button" className={ui.btnPrimary} onClick={handleSave} disabled={isBusy}>
            {isBusy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </>
      )}
    >
      <section className={ui.section}>
        <h3 className={ui.sectionTitle}>Estrategia</h3>

        <div className={styles.previewBox}>
          <span className={ui.metricLabel}>Resumen</span>
          <div className={styles.previewBar}>
            <div className={styles.previewEdge} style={{ flex: em || 0 }}>borde</div>
            <div className={styles.previewCentral} style={{ flex: centralPct || 0 }}>
              {centralPct != null ? `${centralPct}% central` : '—'}
            </div>
            <div className={styles.previewEdge} style={{ flex: em || 0 }}>borde</div>
          </div>
          <span className={ui.fieldHint}>
            ±{Number.isFinite(rw) ? rw : '?'}% del precio · {Number.isFinite(em) ? em : '?'}% margen a cada borde
          </span>
        </div>

        <div className={ui.grid2}>
          {STRATEGY_FIELDS.map((fieldKey) => (
            <StrategyFieldInput
              key={fieldKey}
              fieldKey={fieldKey}
              value={strategy[fieldKey]}
              onChange={handleStrategyField}
            />
          ))}
        </div>
      </section>

      <section className={ui.section}>
        <h3 className={ui.sectionTitle}>Protección delta-neutral</h3>
        {hasActiveProtectedPool && (
          <div className={ui.noticeWarn}>
            Este orquestador tiene una protección activa. Los cambios aquí <strong>sólo afectan al próximo LP</strong>; la protección actual mantiene su configuración hasta que se cierre.
          </div>
        )}
        <ProtectionFormFields
          value={protection}
          onChange={setProtection}
          accounts={accounts}
          initialUsd={initialUsd}
          rangeWidthPct={Number(strategy.rangeWidthPct) || null}
          currentPrice={livePool?.priceCurrent ?? null}
          rangeLowerPrice={livePool?.rangeLowerPrice ?? null}
          rangeUpperPrice={livePool?.rangeUpperPrice ?? null}
        />
      </section>

      {error && <div className={ui.errorBox}>{error}</div>}
    </ModalShell>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { uniswapApi, lpOrchestratorApi } from '../../../services/api';
import ProtectionFormFields, {
  buildDefaultProtection,
  buildProtectionPayload,
  validateProtectionForm,
} from './ProtectionFormFields';
import styles from './CreateOrchestratorWizard.module.css';

const STEP = {
  IDENTITY: 'identity',
  STRATEGY: 'strategy',
  PROTECTION: 'protection',
  REVIEW: 'review',
};

const STEP_TITLES = {
  [STEP.IDENTITY]: '1. Identidad y par',
  [STEP.STRATEGY]: '2. Estrategia',
  [STEP.PROTECTION]: '3. Protección (opcional)',
  [STEP.REVIEW]: '4. Revisión',
};

const DEFAULT_STRATEGY = {
  rangeWidthPct: '5',
  edgeMarginPct: '40',
  costToRewardThreshold: '0.3333',
  minRebalanceCooldownSec: '3600',
  minNetLpEarningsForRebalanceUsd: '0',
  reinvestThresholdUsd: '10',
  urgentAlertRepeatMinutes: '30',
  maxSlippageBps: '100',
};

const FEE_TIERS = [
  { value: 100, label: '0.01%' },
  { value: 500, label: '0.05%' },
  { value: 3000, label: '0.30%' },
  { value: 10000, label: '1.00%' },
];

export default function CreateOrchestratorWizard({
  network = 'arbitrum',
  version = 'v3',
  walletAddress,
  accounts = [],
  onClose,
  onCreated,
}) {
  const [step, setStep] = useState(STEP.IDENTITY);
  const [name, setName] = useState('');
  const [tokenList, setTokenList] = useState([]);
  const [token0Address, setToken0Address] = useState('');
  const [token1Address, setToken1Address] = useState('');
  const [feeTier, setFeeTier] = useState(3000);
  const [initialTotalUsd, setInitialTotalUsd] = useState('1000');
  const [strategy, setStrategy] = useState(DEFAULT_STRATEGY);
  const [protection, setProtection] = useState(buildDefaultProtection(1000));
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    uniswapApi.getSmartCreateTokenList(network)
      .then((list) => { if (!cancelled) setTokenList(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setTokenList([]); });
    return () => { cancelled = true; };
  }, [network]);

  // Mientras la protección esté desactivada, recalculamos los defaults
  // (notional + auto-tune) cuando cambie el capital inicial o el ancho del
  // rango. Si el usuario activa la protección, las modificaciones quedan
  // bajo su control y solo se re-aplica el auto-tune mediante el botón.
  useEffect(() => {
    if (!protection.enabled) {
      setProtection(
        buildDefaultProtection(Number(initialTotalUsd) || 0, Number(strategy.rangeWidthPct) || null)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTotalUsd, strategy.rangeWidthPct]);

  const tokenOptions = useMemo(() => (
    tokenList.map((t) => ({
      value: t.address,
      label: `${t.symbol} (${t.address.slice(0, 6)}…${t.address.slice(-4)})`,
      symbol: t.symbol,
    }))
  ), [tokenList]);

  function findSymbol(address) {
    const tok = tokenList.find((t) => t.address.toLowerCase() === String(address || '').toLowerCase());
    return tok?.symbol || '';
  }

  function validateIdentity() {
    if (!name.trim()) return 'Pon un nombre al orquestador.';
    if (!token0Address) return 'Selecciona el primer token del par.';
    if (!token1Address) return 'Selecciona el segundo token del par.';
    if (token0Address.toLowerCase() === token1Address.toLowerCase()) {
      return 'Los dos tokens deben ser distintos.';
    }
    if (!Number(initialTotalUsd) || Number(initialTotalUsd) <= 0) {
      return 'El capital inicial debe ser un número positivo.';
    }
    if (!walletAddress) return 'Conecta una wallet antes de crear el orquestador.';
    return null;
  }

  function validateStrategy() {
    const rw = Number(strategy.rangeWidthPct);
    if (!Number.isFinite(rw) || rw <= 0 || rw >= 100) {
      return 'El ancho del rango debe estar entre 0 y 100%.';
    }
    const em = Number(strategy.edgeMarginPct);
    if (!Number.isFinite(em) || em < 5 || em > 49) {
      return 'El margen de borde debe estar entre 5% y 49%.';
    }
    const cr = Number(strategy.costToRewardThreshold);
    if (!Number.isFinite(cr) || cr <= 0 || cr >= 1) {
      return 'El umbral coste/recompensa debe estar entre 0 y 1.';
    }
    return null;
  }

  function handleNext() {
    setError('');
    if (step === STEP.IDENTITY) {
      const err = validateIdentity();
      if (err) { setError(err); return; }
      setStep(STEP.STRATEGY);
    } else if (step === STEP.STRATEGY) {
      const err = validateStrategy();
      if (err) { setError(err); return; }
      setStep(STEP.PROTECTION);
    } else if (step === STEP.PROTECTION) {
      const err = validateProtectionForm(protection);
      if (err) { setError(err); return; }
      setStep(STEP.REVIEW);
    }
  }

  function handleBack() {
    setError('');
    if (step === STEP.STRATEGY) setStep(STEP.IDENTITY);
    else if (step === STEP.PROTECTION) setStep(STEP.STRATEGY);
    else if (step === STEP.REVIEW) setStep(STEP.PROTECTION);
  }

  async function handleCreate() {
    setError('');
    setIsBusy(true);
    try {
      const payload = {
        name: name.trim(),
        network,
        version,
        walletAddress,
        token0Address,
        token1Address,
        token0Symbol: findSymbol(token0Address) || 'TOKEN0',
        token1Symbol: findSymbol(token1Address) || 'TOKEN1',
        feeTier: Number(feeTier),
        initialTotalUsd: Number(initialTotalUsd),
        strategyConfig: {
          rangeWidthPct: Number(strategy.rangeWidthPct),
          edgeMarginPct: Number(strategy.edgeMarginPct),
          costToRewardThreshold: Number(strategy.costToRewardThreshold),
          minRebalanceCooldownSec: Number(strategy.minRebalanceCooldownSec),
          minNetLpEarningsForRebalanceUsd: Number(strategy.minNetLpEarningsForRebalanceUsd),
          reinvestThresholdUsd: Number(strategy.reinvestThresholdUsd),
          urgentAlertRepeatMinutes: Number(strategy.urgentAlertRepeatMinutes),
          maxSlippageBps: Number(strategy.maxSlippageBps),
        },
        protectionConfig: buildProtectionPayload(protection),
      };
      const created = await lpOrchestratorApi.create(payload);
      // El padre (LpOrchestratorPage) cierra este wizard y abre el flujo de
      // creación de LP con los datos ya pre-cargados — evitamos repetir al
      // usuario el par/fee/capital que acaba de definir.
      onCreated?.(created);
    } catch (err) {
      setError(err.message || 'No se pudo crear el orquestador.');
    } finally {
      setIsBusy(false);
    }
  }

  const stepOrder = [STEP.IDENTITY, STEP.STRATEGY, STEP.PROTECTION, STEP.REVIEW];
  const currentStepIndex = stepOrder.indexOf(step);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>LP Orchestrator</span>
            <h2 className={styles.title}>Crear orquestador</h2>
            {STEP_TITLES[step] && <p className={styles.stepLabel}>{STEP_TITLES[step]}</p>}
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose}>✕</button>
        </header>

        <Stepper currentIndex={currentStepIndex} stepOrder={stepOrder} />

        <div className={styles.body}>
          {step === STEP.IDENTITY && (
            <IdentityStep
              name={name} setName={setName}
              tokenOptions={tokenOptions}
              token0Address={token0Address} setToken0Address={setToken0Address}
              token1Address={token1Address} setToken1Address={setToken1Address}
              feeTier={feeTier} setFeeTier={setFeeTier}
              initialTotalUsd={initialTotalUsd} setInitialTotalUsd={setInitialTotalUsd}
              network={network} version={version}
            />
          )}

          {step === STEP.STRATEGY && (
            <StrategyStep strategy={strategy} setStrategy={setStrategy} />
          )}

          {step === STEP.PROTECTION && (
            <ProtectionFormFields
              value={protection}
              onChange={setProtection}
              accounts={accounts}
              initialUsd={Number(initialTotalUsd) || 0}
              rangeWidthPct={Number(strategy.rangeWidthPct) || null}
            />
          )}

          {step === STEP.REVIEW && (
            <ReviewStep
              name={name}
              token0Symbol={findSymbol(token0Address)}
              token1Symbol={findSymbol(token1Address)}
              network={network}
              version={version}
              feeTier={feeTier}
              initialTotalUsd={initialTotalUsd}
              strategy={strategy}
              protection={protection}
            />
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <footer className={styles.footer}>
          {step !== STEP.IDENTITY && (
            <button type="button" className={styles.btn} onClick={handleBack}>← Atrás</button>
          )}
          <div className={styles.spacer} />
          {step !== STEP.REVIEW && (
            <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={handleNext}>
              Siguiente →
            </button>
          )}
          {step === STEP.REVIEW && (
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              onClick={handleCreate}
              disabled={isBusy}
            >
              {isBusy ? 'Creando…' : 'Crear orquestador'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function IdentityStep({
  name, setName,
  tokenOptions, token0Address, setToken0Address, token1Address, setToken1Address,
  feeTier, setFeeTier,
  initialTotalUsd, setInitialTotalUsd,
  network, version,
}) {
  return (
    <div className={styles.fields}>
      <div className={styles.field}>
        <label>Nombre del orquestador</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ej. WETH/USDC arbitrum"
          maxLength={255}
        />
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label>Red</label>
          <input type="text" value={network} disabled />
        </div>
        <div className={styles.field}>
          <label>Versión</label>
          <input type="text" value={version} disabled />
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label>Token 0</label>
          <select value={token0Address} onChange={(e) => setToken0Address(e.target.value)}>
            <option value="">— selecciona —</option>
            {tokenOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label>Token 1</label>
          <select value={token1Address} onChange={(e) => setToken1Address(e.target.value)}>
            <option value="">— selecciona —</option>
            {tokenOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>

      <div className={styles.field}>
        <label>Fee tier</label>
        <div className={styles.feeTiers}>
          {FEE_TIERS.map((tier) => (
            <button
              key={tier.value}
              type="button"
              className={`${styles.feeBtn} ${feeTier === tier.value ? styles.feeBtnActive : ''}`}
              onClick={() => setFeeTier(tier.value)}
            >
              {tier.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label>Capital inicial (USD)</label>
        <input
          type="number"
          min="1"
          step="1"
          value={initialTotalUsd}
          onChange={(e) => setInitialTotalUsd(e.target.value)}
        />
        <span className={styles.hint}>
          Es solo una referencia para el dimensionamiento de la protección. El monto real lo defines al crear el LP.
        </span>
      </div>
    </div>
  );
}

function StrategyStep({ strategy, setStrategy }) {
  const handleField = (key, value) => setStrategy({ ...strategy, [key]: value });
  const rw = Number(strategy.rangeWidthPct);
  const em = Number(strategy.edgeMarginPct);
  const centralPct = Number.isFinite(rw) && Number.isFinite(em) ? (100 - 2 * em) : null;

  return (
    <div className={styles.fields}>
      <div className={styles.strategyPreview}>
        <div className={styles.previewBox}>
          <span className={styles.previewLabel}>Resumen de la estrategia</span>
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
            ±{Number.isFinite(rw) ? rw : '?'}% del precio actual · {Number.isFinite(em) ? em : '?'}% margen a cada borde
          </span>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <FieldLabel
            text="Ancho del rango (±%)"
            tooltip="Define el ancho del LP en Uniswap V3. El LP se centra en el precio actual y se extiende ±este % a cada lado. Valores típicos: 1-3% (estrecho, más fees, mayor riesgo de salir de rango), 5-10% (medio), >10% (amplio, menos fees, más estable)."
          />
          <input
            type="number" min="0.1" max="99" step="0.5"
            value={strategy.rangeWidthPct}
            onChange={(e) => handleField('rangeWidthPct', e.target.value)}
          />
          <span className={styles.hint}>
            Ej: 5 → el LP cubrirá precio × [0.95, 1.05]
          </span>
        </div>
        <div className={styles.field}>
          <FieldLabel
            text="Margen de borde (%)"
            tooltip="Cuánto del rango cuenta como 'borde' a cada lado. Si pones 40%, los bordes ocupan el 40% inferior + 40% superior = 80%, y el centro 'sin alerta' es solo el 20% central. Cuando el precio entra al borde, el orquestador evalúa si vale la pena rebalancear."
          />
          <input
            type="number" min="5" max="49" step="1"
            value={strategy.edgeMarginPct}
            onChange={(e) => handleField('edgeMarginPct', e.target.value)}
          />
          <span className={styles.hint}>
            Centro sin alerta: <strong>{centralPct != null ? `${centralPct}%` : '—'}</strong> del rango
          </span>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <FieldLabel
            text="Umbral coste / recompensa"
            tooltip="Solo se recomienda rebalancear cuando el coste estimado (gas + slippage) es menor que ganancias_netas × este valor. Default 0.33 → coste < 1/3 de las ganancias netas del LP. Subirlo recomienda más rebalanceos; bajarlo, menos."
          />
          <input
            type="number" min="0.01" max="0.99" step="0.01"
            value={strategy.costToRewardThreshold}
            onChange={(e) => handleField('costToRewardThreshold', e.target.value)}
          />
          <span className={styles.hint}>
            0.33 = coste &lt; 1/3 ganancias
          </span>
        </div>
        <div className={styles.field}>
          <FieldLabel
            text="Umbral reinvest fees (USD)"
            tooltip="El orquestador recomendará cobrar/reinvertir las fees del LP cuando las acumuladas superen este USD. Pon 0 para desactivar la recomendación."
          />
          <input
            type="number" min="0" step="1"
            value={strategy.reinvestThresholdUsd}
            onChange={(e) => handleField('reinvestThresholdUsd', e.target.value)}
          />
          <span className={styles.hint}>
            Recomienda cobrar a partir de este monto
          </span>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <FieldLabel
            text="Repetir alerta urgente cada (min)"
            tooltip="Cuando el LP queda fuera de rango, el orquestador envía una alerta y la repite cada N minutos hasta que el precio vuelva al rango o la posición se ajuste."
          />
          <input
            type="number" min="1" max="1440" step="1"
            value={strategy.urgentAlertRepeatMinutes}
            onChange={(e) => handleField('urgentAlertRepeatMinutes', e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <FieldLabel
            text="Cooldown anti-thrashing (s)"
            tooltip="Tiempo mínimo (en segundos) entre rebalanceos consecutivos para evitar que pequeñas oscilaciones del precio disparen muchos rebalanceos seguidos."
          />
          <input
            type="number" min="0" step="60"
            value={strategy.minRebalanceCooldownSec}
            onChange={(e) => handleField('minRebalanceCooldownSec', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function ReviewStep({
  name, token0Symbol, token1Symbol, network, version, feeTier,
  initialTotalUsd, strategy, protection,
}) {
  const protPayload = buildProtectionPayload(protection);
  return (
    <div className={styles.review}>
      <Section title="Identidad">
        <Row k="Nombre" v={name} />
        <Row k="Par" v={`${token0Symbol || '?'} / ${token1Symbol || '?'}`} />
        <Row k="Red" v={network} />
        <Row k="Versión" v={version} />
        <Row k="Fee tier" v={`${(feeTier / 10000).toFixed(2)}%`} />
        <Row k="Capital inicial" v={`$${initialTotalUsd}`} />
      </Section>
      <Section title="Estrategia">
        <Row k="Ancho del rango" v={`±${strategy.rangeWidthPct}%`} />
        <Row k="Margen de borde" v={`${strategy.edgeMarginPct}%`} />
        <Row k="Banda central" v={`${100 - 2 * Number(strategy.edgeMarginPct)}% del rango`} />
        <Row k="Umbral coste/recompensa" v={strategy.costToRewardThreshold} />
        <Row k="Umbral reinvest" v={`$${strategy.reinvestThresholdUsd}`} />
        <Row k="Alertas urgentes" v={`cada ${strategy.urgentAlertRepeatMinutes} min`} />
      </Section>
      <Section title="Protección delta-neutral">
        {protPayload.enabled ? (
          <>
            <Row k="Estado" v="Activa" />
            <Row k="Cuenta" v={`#${protPayload.accountId}`} />
            <Row k="Notional USD" v={`$${protPayload.configuredNotionalUsd}`} />
            <Row k="Leverage" v={`${protPayload.leverage}x`} />
            <Row k="Band mode" v={protPayload.bandMode} />
            <Row k="Rebalance trigger" v={`${protPayload.baseRebalancePriceMovePct}%`} />
          </>
        ) : (
          <Row k="Estado" v="Desactivada" />
        )}
      </Section>
      <p className={styles.note}>
        Al confirmar, el orquestador se creará y a continuación se abrirá automáticamente el flujo de creación del LP con estos mismos datos pre-cargados.
      </p>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className={styles.section}>
      <h4>{title}</h4>
      <div className={styles.sectionRows}>{children}</div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className={styles.reviewRow}>
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

const STEPPER_LABELS = [
  { id: 'identity', label: 'Identidad', short: '1' },
  { id: 'strategy', label: 'Estrategia', short: '2' },
  { id: 'protection', label: 'Protección', short: '3' },
  { id: 'review', label: 'Revisión', short: '4' },
];

function Stepper({ currentIndex, stepOrder }) {
  return (
    <div className={styles.stepper} role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin={1} aria-valuemax={stepOrder.length}>
      {STEPPER_LABELS.map((s, i) => {
        const isCurrent = i === currentIndex;
        const isDone = i < currentIndex;
        const cls = `${styles.stepDot} ${isCurrent ? styles.stepDotCurrent : ''} ${isDone ? styles.stepDotDone : ''}`;
        return (
          <div key={s.id} className={styles.stepItem}>
            <div className={cls}>
              {isDone ? '✓' : s.short}
            </div>
            <span className={`${styles.stepText} ${isCurrent ? styles.stepTextCurrent : ''}`}>
              {s.label}
            </span>
            {i < STEPPER_LABELS.length - 1 && (
              <div className={`${styles.stepLine} ${isDone ? styles.stepLineDone : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FieldLabel({ text, tooltip }) {
  return (
    <label className={styles.fieldLabel}>
      {text}
      {tooltip && (
        <span className={styles.tooltipIcon} title={tooltip} aria-label={tooltip}>
          ⓘ
        </span>
      )}
    </label>
  );
}

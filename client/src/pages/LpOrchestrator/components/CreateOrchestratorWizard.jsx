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

// Espejo de DEFAULT_V4_TICK_SPACING_BY_FEE en
// server/src/services/smart-pool-creator.service.js. Solo se usa para
// mostrar el valor que el backend derivará; no se envía salvo override.
const DEFAULT_V4_TICK_SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

// Redes donde se puede orquestar un LP. La testnet existe para validar los
// flujos on-chain sin capital real; se marca para que no se confunda con
// una red productiva.
// Identidad estable de un pool dentro de la lista (par + fee la fijan).
function poolKeyOf(pool) {
  return `${pool.token0.address}-${pool.token1.address}-${pool.fee}`;
}

const NETWORK_OPTIONS = [
  { id: 'arbitrum', label: 'Arbitrum One' },
  { id: 'base-sepolia', label: 'Base Sepolia (testnet)', isTestnet: true },
];

export default function CreateOrchestratorWizard({
  network: initialNetwork = 'arbitrum',
  version: initialVersion = 'v3',
  walletAddress,
  accounts = [],
  onClose,
  onCreated,
}) {
  const [step, setStep] = useState(STEP.IDENTITY);
  const [network, setNetwork] = useState(initialNetwork);
  const [version, setVersion] = useState(initialVersion);
  const [name, setName] = useState('');
  const [pools, setPools] = useState([]);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const [poolsError, setPoolsError] = useState('');
  const [selectedPoolKey, setSelectedPoolKey] = useState('');
  const [poolSearch, setPoolSearch] = useState('');
  const [initialTotalUsd, setInitialTotalUsd] = useState('1000');
  const [strategy, setStrategy] = useState(DEFAULT_STRATEGY);
  const [protection, setProtection] = useState(buildDefaultProtection(1000));
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  // Solo se puede crear una posicion sobre un pool que YA existe (tanto en v3
  // como en v4), asi que la lista se resuelve on-chain y el usuario elige de
  // ahi. Cambiar de red o de version invalida la seleccion previa.
  useEffect(() => {
    let cancelled = false;
    setPoolsLoading(true);
    setPoolsError('');
    setSelectedPoolKey('');
    uniswapApi.getSmartCreatePools({ network, version })
      .then((data) => {
        if (cancelled) return;
        const found = Array.isArray(data?.pools) ? data.pools : [];
        setPools(found);
        // Preseleccionamos el primero con liquidez para que el camino feliz
        // sea un click menos.
        const first = found.find((p) => p.hasLiquidity) || found[0];
        if (first) setSelectedPoolKey(poolKeyOf(first));
      })
      .catch((err) => {
        if (cancelled) return;
        setPools([]);
        setPoolsError(err?.message || 'error desconocido');
      })
      .finally(() => { if (!cancelled) setPoolsLoading(false); });
    return () => { cancelled = true; };
  }, [network, version]);

  const selectedPool = useMemo(
    () => pools.find((p) => poolKeyOf(p) === selectedPoolKey) || null,
    [pools, selectedPoolKey]
  );

  // Filtra por simbolo o por fee ("weth", "usdc", "0.05"). Mainnet devuelve
  // decenas de pools y buscarlos a ojo es incomodo.
  const visiblePools = useMemo(() => {
    const term = poolSearch.trim().toLowerCase();
    if (!term) return pools;
    return pools.filter((pool) => (
      pool.label.toLowerCase().includes(term)
      || pool.token0.symbol.toLowerCase().includes(term)
      || pool.token1.symbol.toLowerCase().includes(term)
      || `${pool.fee / 10000}`.includes(term)
    ));
  }, [pools, poolSearch]);

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

  function validateIdentity() {
    if (!name.trim()) return 'Pon un nombre al orquestador.';
    if (poolsLoading) return 'Esperá a que termine de cargar la lista de pools.';
    // El pool sale de la lista descubierta on-chain, asi que no hace falta
    // validar par ni fee: no se puede componer una combinacion inexistente.
    if (!selectedPool) return 'Selecciona un pool.';
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
        token0Address: selectedPool.token0.address,
        token1Address: selectedPool.token1.address,
        token0Symbol: selectedPool.token0.symbol,
        token1Symbol: selectedPool.token1.symbol,
        feeTier: Number(selectedPool.fee),
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
          // El tickSpacing viene del pool descubierto on-chain; solo se
          // persiste si difiere del que el backend derivaria del fee tier.
          ...(version === 'v4'
            && selectedPool.tickSpacing != null
            && selectedPool.tickSpacing !== DEFAULT_V4_TICK_SPACING_BY_FEE[selectedPool.fee]
            ? { v4TickSpacing: Number(selectedPool.tickSpacing) }
            : {}),
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
              pools={visiblePools} totalPools={pools.length}
              poolSearch={poolSearch} setPoolSearch={setPoolSearch}
              poolsLoading={poolsLoading} poolsError={poolsError}
              selectedPoolKey={selectedPoolKey} setSelectedPoolKey={setSelectedPoolKey}
              initialTotalUsd={initialTotalUsd} setInitialTotalUsd={setInitialTotalUsd}
              network={network} setNetwork={setNetwork}
              version={version} setVersion={setVersion}
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
              token0Symbol={selectedPool?.token0.symbol || ''}
              token1Symbol={selectedPool?.token1.symbol || ''}
              network={network}
              version={version}
              feeTier={selectedPool?.fee}
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
  pools, totalPools, poolSearch, setPoolSearch,
  poolsLoading, poolsError,
  selectedPoolKey, setSelectedPoolKey,
  initialTotalUsd, setInitialTotalUsd,
  network, setNetwork, version, setVersion,
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
          <select aria-label="Red" value={network} onChange={(e) => setNetwork(e.target.value)}>
            {NETWORK_OPTIONS.map((n) => (
              <option key={n.id} value={n.id}>{n.label}</option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>Versión</label>
          <select aria-label="Versión" value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="v3">v3</option>
            <option value="v4">v4</option>
          </select>
        </div>
      </div>

      <div className={styles.field}>
        <label>Pool</label>
        {version === 'v4' && (
          <p className={styles.hint}>
            Solo se listan pools <strong>sin hook y con tokens ERC-20</strong>:
            la gestión on-chain rechaza los hooks y el ETH nativo, así que un
            pool así se podría crear pero no rebalancear ni cerrar.
          </p>
        )}
        {poolsLoading && <p className={styles.hint}>Buscando pools en {network}…</p>}
        {!poolsLoading && poolsError && (
          <p className={styles.hint}>No se pudieron cargar los pools: {poolsError}</p>
        )}
        {!poolsLoading && !poolsError && totalPools > 0 && (
          <input
            type="search"
            aria-label="Buscar pool"
            className={styles.poolSearch}
            value={poolSearch}
            onChange={(e) => setPoolSearch(e.target.value)}
            placeholder={`Buscar entre ${totalPools} pools — token o fee (ej. WETH, 0.05)`}
          />
        )}
        {!poolsLoading && !poolsError && totalPools === 0 && (
          <p className={styles.hint}>
            No hay pools {version} en esta red para los tokens conocidos.
            Probá con la otra versión.
          </p>
        )}
        {!poolsLoading && !poolsError && totalPools > 0 && pools.length === 0 && (
          <p className={styles.hint}>Ningún pool coincide con «{poolSearch}».</p>
        )}
        {!poolsLoading && pools.length > 0 && (
          <div className={styles.poolList} role="radiogroup" aria-label="Pool">
            {pools.map((pool) => {
              const id = poolKeyOf(pool);
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selectedPoolKey === id}
                  className={`${styles.poolBtn} ${selectedPoolKey === id ? styles.poolBtnActive : ''}`}
                  onClick={() => setSelectedPoolKey(id)}
                  title={pool.hasLiquidity
                    ? `${pool.label} · ${pool.fee / 10000}%`
                    : 'Este pool existe pero no tiene liquidez: el swap de fondeo puede fallar'}
                >
                  <span className={styles.poolPair}>{pool.label}</span>
                  <span className={styles.poolFee}>{pool.fee / 10000}%</span>
                  {!pool.hasLiquidity && <span className={styles.poolWarn}>sin liquidez</span>}
                </button>
              );
            })}
          </div>
        )}
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

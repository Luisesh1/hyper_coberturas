import useAdoptLpFlow, { ADOPT_STEP, ADOPT_STEPS } from './useAdoptLpFlow';
import StepProtection from '../lp-wizard/steps/StepProtection';
import { formatUsd } from '../../pages/UniswapPools/utils/pool-formatters';
import wizardStyles from '../lp-wizard/UnifiedLpWizard.module.css';
import styles from './AdoptLpWizard.module.css';

const ORCHESTRABLE_VERSIONS = ['v3', 'v4'];
const DYNAMIC_FEE_FLAG = 0x800000;

const PROVENANCE_LABEL = {
  chain: 'cadena',
  derived: 'derivado',
  default: 'por defecto',
};

function Source({ kind }) {
  return <span className={`${styles.src} ${styles[`src_${kind}`] || ''}`}>{PROVENANCE_LABEL[kind] || kind}</span>;
}

function shortAddress(address) {
  if (!address) return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatFee(fee) {
  if (fee == null) return '—';
  if (Number(fee) === DYNAMIC_FEE_FLAG) return 'Comisión dinámica';
  return `${Number((Number(fee) / 10_000).toFixed(4))}%`;
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-ES', { maximumSignificantDigits: 6 });
}

function Stepper({ step }) {
  const currentIndex = ADOPT_STEPS.findIndex((item) => item.id === step);
  return (
    <div className={wizardStyles.stepper} role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin={1} aria-valuemax={ADOPT_STEPS.length}>
      {ADOPT_STEPS.map((item, i) => (
        <div key={item.id} className={wizardStyles.stepItem}>
          <div className={`${wizardStyles.dot} ${i === currentIndex ? wizardStyles.dotOn : ''} ${i < currentIndex ? wizardStyles.dotDone : ''}`}>
            {i < currentIndex ? '✓' : i + 1}
          </div>
          <span className={`${wizardStyles.stepText} ${i === currentIndex ? wizardStyles.stepTextOn : ''}`}>{item.label}</span>
          {i < ADOPT_STEPS.length - 1 && <div className={`${wizardStyles.line} ${i < currentIndex ? wizardStyles.lineDone : ''}`} />}
        </div>
      ))}
    </div>
  );
}

function RangeBar({ position }) {
  const lower = Number(position.rangeLowerPrice);
  const upper = Number(position.rangeUpperPrice);
  const price = Number(position.priceCurrent);
  if (![lower, upper].every(Number.isFinite) || upper <= lower) return null;
  // El rango ocupa el 60 % central; el precio se sitúa en escala logarítmica.
  const span = Math.log(upper / lower);
  const pricePct = Number.isFinite(price) && price > 0
    ? Math.min(100, Math.max(0, 20 + (Math.log(price / lower) / span) * 60))
    : null;
  return (
    <div className={styles.range} aria-label={`Rango ${formatPrice(lower)} a ${formatPrice(upper)}`}>
      <div className={styles.rangeTrack} />
      <div className={`${styles.rangeBand} ${position.inRange ? '' : styles.rangeBandOut}`} />
      {pricePct != null && <div className={styles.rangePrice} style={{ left: `${pricePct}%` }} />}
      <span className={styles.rangeLbl} style={{ left: '20%' }}>{formatPrice(lower)}</span>
      <span className={styles.rangeLbl} style={{ left: '80%' }}>{formatPrice(upper)}</span>
    </div>
  );
}

function CandidateTags({ candidate }) {
  const { position, hook, protection } = candidate;
  return (
    <>
      <span className={styles.tag}>{position.version} · {formatFee(position.fee)}</span>
      {hook && <span className={styles.tag}>hook {shortAddress(hook.address)}</span>}
      {candidate.eligible && (
        <span className={`${styles.tag} ${position.inRange ? styles.tagOk : styles.tagWarn}`}>
          {position.inRange ? 'en rango' : 'fuera de rango'}
        </span>
      )}
      {protection?.existing && <span className={`${styles.tag} ${styles.tagWarn}`}>ya cubierto</span>}
      {!candidate.eligible && <span className={`${styles.tag} ${styles.tagBad}`}>no adoptable</span>}
    </>
  );
}

function StepPosition({ flow, networkOptions }) {
  return (
    <div className={wizardStyles.stepBody}>
      <div className={wizardStyles.selectorRow}>
        <div className={wizardStyles.field}>
          <label htmlFor="adopt-network">Red</label>
          <select id="adopt-network" value={flow.network} onChange={(e) => flow.setNetwork(e.target.value)}>
            {networkOptions.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
        </div>
        <div className={wizardStyles.field}>
          <label htmlFor="adopt-wallet">Wallet dueña del LP</label>
          <input
            id="adopt-wallet"
            value={flow.walletAddress}
            onChange={(e) => flow.setWalletAddress(e.target.value.trim())}
            placeholder="0x…"
            spellCheck={false}
          />
        </div>
      </div>
      <div className={styles.scanRow}>
        <span className={wizardStyles.hint}>Se buscan a la vez las posiciones v3 y v4 de la red. Las que no tienen liquidez no aparecen.</span>
        <button type="button" className={wizardStyles.btnPrimary} onClick={flow.scan} disabled={flow.scanBusy}>
          {flow.scanBusy ? 'Buscando…' : flow.candidates ? 'Volver a buscar' : 'Buscar posiciones'}
        </button>
      </div>

      {flow.scanError && <p className={wizardStyles.errorText}>{flow.scanError}</p>}
      {flow.warnings.length > 0 && (
        <div className={`${wizardStyles.card} ${wizardStyles.cardWarn}`}>
          {flow.warnings.map((warning) => <span key={warning} className={wizardStyles.hint}>{warning}</span>)}
        </div>
      )}

      {flow.candidates && flow.candidates.length === 0 && (
        <p className={wizardStyles.hint}>No hay posiciones con liquidez en esta wallet y red.</p>
      )}

      {flow.candidates && flow.candidates.length > 0 && (
        <div className={styles.list} role="radiogroup" aria-label="Posiciones de la wallet">
          {flow.candidates.map((candidate) => {
            const { position } = candidate;
            const isSelected = flow.selected?.position.identifier === position.identifier
              && flow.selected?.position.version === position.version;
            return (
              <button
                key={`${position.version}-${position.identifier}`}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={!candidate.eligible}
                className={`${styles.lp} ${isSelected ? styles.lpOn : ''}`}
                onClick={() => flow.selectCandidate(candidate)}
              >
                <span className={styles.radio} aria-hidden="true" />
                <span className={styles.lpMain}>
                  <span className={styles.lpTitle}>
                    {position.token0?.symbol}/{position.token1?.symbol}
                    <span className={styles.lpId}>#{position.identifier}</span>
                  </span>
                  <span className={styles.tags}><CandidateTags candidate={candidate} /></span>
                  {candidate.eligible ? <RangeBar position={position} /> : (
                    <span className={styles.blocked}>{candidate.blockedReason}</span>
                  )}
                </span>
                <span className={styles.lpValue}>
                  {position.currentValueUsd != null ? formatUsd(position.currentValueUsd) : '—'}
                  {Number(position.unclaimedFeesUsd) > 0 && (
                    <small>+{formatUsd(position.unclaimedFeesUsd)} fees</small>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, source, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children ?? value}</span>
      {source && <Source kind={source} />}
    </div>
  );
}

function StepDetails({ flow }) {
  const { position, prefill, provenance, hook } = flow.selected;
  const strategy = prefill.strategyConfig;
  return (
    <div className={wizardStyles.stepBody}>
      <p className={wizardStyles.hint}>
        Lo marcado como <Source kind="chain" /> es la identidad del pool: el orquestador la necesita
        para recrear el LP en el mismo pool, así que no se edita.
      </p>
      <div className={styles.rows}>
        <div className={styles.groupHead}>Identidad</div>
        <Row label="Red / versión" value={`${position.network} · ${position.version}`} source="chain" />
        <Row label="Wallet dueña" value={shortAddress(position.walletAddress)} source="chain" />
        <Row label="Par" value={`${prefill.token0Symbol} / ${prefill.token1Symbol}`} source="chain" />
        <Row
          label="Fee"
          value={`${formatFee(prefill.feeTier)}${strategy.v4TickSpacing != null ? ` · tickSpacing ${strategy.v4TickSpacing}` : ''}`}
          source="chain"
        />
        {hook && (
          <Row
            label="Hook"
            value={`${shortAddress(hook.address)}${hook.verifiedVersionId ? ' · verificado' : ''}${hook.swapReturnsDelta ? ' · deltas en swaps' : ''}`}
            source="chain"
          />
        )}
        {position.poolId && <Row label="Pool ID" value={shortAddress(position.poolId)} source="chain" />}
        <Row label="Activo de cobertura" value={prefill.inferredAsset || '—'} source="derived" />
        <Row
          label="Rango del LP"
          value={`${formatPrice(position.rangeLowerPrice)} – ${formatPrice(position.rangeUpperPrice)} · precio ${formatPrice(position.priceCurrent)}`}
          source="chain"
        />

        <div className={styles.groupHead}>Capital y estrategia</div>
        <Row label="Capital inicial (USD)" source={provenance.initialTotalUsd}>
          <input
            id="adopt-capital"
            className={styles.input}
            inputMode="decimal"
            value={flow.form.initialTotalUsd}
            onChange={(e) => flow.setField('initialTotalUsd', e.target.value)}
            aria-label="Capital inicial en USD"
          />
        </Row>
        <Row label="Ancho de rango (± %)" source={provenance.rangeWidthPct}>
          <input
            id="adopt-width"
            className={styles.input}
            inputMode="decimal"
            value={flow.form.rangeWidthPct}
            onChange={(e) => flow.setField('rangeWidthPct', e.target.value)}
            aria-label="Ancho de rango en porcentaje"
          />
        </Row>
        <Row
          label="Ancho del recomendador"
          value={`${strategy.minRangeWidthPct} % – ${strategy.maxRangeWidthPct} %`}
          source={provenance.minRangeWidthPct === 'derived' || provenance.maxRangeWidthPct === 'derived' ? 'derived' : 'default'}
        />
        <Row label="Margen de borde (%)" source="default">
          <input
            id="adopt-edge"
            className={styles.input}
            inputMode="decimal"
            value={flow.form.edgeMarginPct}
            onChange={(e) => flow.setField('edgeMarginPct', e.target.value)}
            aria-label="Margen de borde en porcentaje"
          />
        </Row>
        <Row label="Slippage máximo (bps)" source="default">
          <input
            id="adopt-slippage"
            className={styles.input}
            inputMode="numeric"
            value={flow.form.maxSlippageBps}
            onChange={(e) => flow.setField('maxSlippageBps', e.target.value)}
            aria-label="Slippage máximo en puntos básicos"
          />
        </Row>
        <Row label="Nombre" source="derived">
          <input
            id="adopt-name"
            className={styles.input}
            value={flow.form.name}
            onChange={(e) => flow.setField('name', e.target.value)}
            aria-label="Nombre del orquestador"
          />
        </Row>
      </div>
      {!position.inRange && (
        <p className={`${wizardStyles.card} ${wizardStyles.cardWarn} ${wizardStyles.hint}`}>
          La posición está fuera de rango. El orquestador conserva el ancho elegido y recomendará recentrar en su primera evaluación.
        </p>
      )}
      <span className={wizardStyles.hint}>
        El ancho se mide desde el centro geométrico del rango (√(inferior·superior)), no desde el precio actual.
      </span>
    </div>
  );
}

const MODE_COPY = {
  new: { title: 'Abrir una cobertura nueva', desc: 'Un short en Hyperliquid configurado con los datos del LP.' },
  reuse: { title: 'Conservar la cobertura actual', desc: 'Se vincula al orquestador sin cerrar ni abrir ningún short.' },
  none: { title: 'Sin cobertura', desc: 'Solo seguimiento, contabilidad y alertas.' },
};

function StepAdoptProtection({ flow, accounts }) {
  const { protection: options, position, prefill } = flow.selected;
  return (
    <div className={wizardStyles.stepBody}>
      <div className={styles.modes} role="radiogroup" aria-label="Cobertura">
        {options.modes.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={flow.protectionMode === mode}
            className={`${styles.mode} ${flow.protectionMode === mode ? styles.modeOn : ''}`}
            onClick={() => flow.setProtectionMode(mode)}
          >
            <strong>{MODE_COPY[mode].title}</strong>
            <span>{MODE_COPY[mode].desc}</span>
          </button>
        ))}
      </div>

      {options.warning && <p className={`${wizardStyles.card} ${wizardStyles.cardWarn} ${wizardStyles.hint}`}>{options.warning}</p>}
      {options.allowedPolicies && flow.protectionMode === 'new' && (
        <p className={wizardStyles.hint}>
          El hook de este pool devuelve deltas en swaps: solo se admiten las políticas de borde de rango y terminal.
        </p>
      )}

      {flow.protectionMode === 'reuse' && options.existing && (
        <div className={wizardStyles.card}>
          <div className={wizardStyles.kv}><span>Cobertura</span><strong>#{options.existing.id} · {options.existing.protectionMode}</strong></div>
          <div className={wizardStyles.kv}><span>Cuenta</span><strong>#{options.existing.accountId}</strong></div>
          <div className={wizardStyles.kv}><span>Apalancamiento</span><strong>{options.existing.leverage}x</strong></div>
          {options.existing.configuredHedgeNotionalUsd != null && (
            <div className={wizardStyles.kv}><span>Notional</span><strong>{formatUsd(options.existing.configuredHedgeNotionalUsd)}</strong></div>
          )}
        </div>
      )}

      {flow.protectionMode === 'new' && flow.protection && (
        <StepProtection
          protection={flow.protection}
          setProtection={flow.setProtection}
          accounts={accounts}
          lpWalletAddress={position.walletAddress}
          defaultLeverage={String(options.candidate?.defaultLeverage || 10)}
          capitalUsd={Number(flow.form.initialTotalUsd) || prefill.initialTotalUsd}
          rangeWidthPct={Number(flow.form.rangeWidthPct) || prefill.strategyConfig.rangeWidthPct}
          currentPrice={position.priceCurrent}
          rangeLowerPrice={position.rangeLowerPrice}
          rangeUpperPrice={position.rangeUpperPrice}
          allowedPolicies={options.allowedPolicies}
          preflight={flow.preflight}
          preflightBusy={flow.preflightBusy}
          onRunPreflight={flow.runPreflight}
        />
      )}
    </div>
  );
}

function StepReview({ flow }) {
  const { position, prefill } = flow.selected;
  const unclaimed = Number(position.unclaimedFeesUsd) || 0;
  const coverage = flow.protectionMode === 'new'
    ? `Nueva · ${flow.protection?.policyVersion} · ${flow.protection?.leverage}x`
    : flow.protectionMode === 'reuse' ? `Se conserva la #${flow.selected.protection.existing?.id}` : 'Sin cobertura';
  return (
    <div className={wizardStyles.stepBody}>
      <div className={wizardStyles.card}>
        <div className={wizardStyles.kv}><span>Nombre</span><strong>{flow.form.name}</strong></div>
        <div className={wizardStyles.kv}><span>Posición</span><strong>{prefill.token0Symbol}/{prefill.token1Symbol} #{position.identifier} · {position.network} {position.version}</strong></div>
        <div className={wizardStyles.kv}><span>Capital inicial</span><strong>{formatUsd(Number(flow.form.initialTotalUsd))}</strong></div>
        <div className={wizardStyles.kv}><span>Ancho de rango</span><strong>±{flow.form.rangeWidthPct} %</strong></div>
        <div className={wizardStyles.kv}><span>Margen de borde</span><strong>{flow.form.edgeMarginPct} %</strong></div>
        <div className={wizardStyles.kv}><span>Cobertura</span><strong>{coverage}</strong></div>
      </div>
      <ul className={styles.checklist}>
        <li>No hay firmas: el LP no se toca.</li>
        <li>El servidor vuelve a leer la posición en la cadena antes de crear el orquestador.</li>
        {flow.protectionMode === 'new' && <li>Si la cobertura no se puede abrir, no se crea el orquestador y vuelves a este asistente con la configuración intacta.</li>}
        <li>
          El resultado del orquestador empieza hoy.
          {unclaimed > 0 && ` Las fees sin cobrar (${formatUsd(unclaimed)}) quedan como saldo de partida.`}
        </li>
      </ul>
      {flow.submitError && (
        <div className={`${wizardStyles.card} ${wizardStyles.cardErr}`}>
          <p className={wizardStyles.errorText}>{flow.submitError.message}</p>
          {flow.submitError.compensations.map((step) => (
            <span key={step.id} className={wizardStyles.hint}>{step.ok ? '✓' : '✕'} {step.detail}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Asistente para que un orquestador nuevo adopte un LP que ya está en la
 * wallet. No firma nada: la configuración sale de la propia posición.
 */
export default function AdoptLpWizard({ walletAddress = '', meta, accounts = [], defaultNetwork, onClose, onCompleted }) {
  const networkOptions = (Array.isArray(meta?.networks) ? meta.networks : [])
    .filter((n) => (n.versions || []).some((v) => ORCHESTRABLE_VERSIONS.includes(v)));
  const options = networkOptions.length ? networkOptions : [{ id: 'arbitrum', label: 'Arbitrum', versions: ['v3', 'v4'] }];
  const flow = useAdoptLpFlow({
    defaultNetwork: defaultNetwork && options.some((n) => n.id === defaultNetwork) ? defaultNetwork : options[0].id,
    defaultWallet: walletAddress,
    onCompleted,
  });
  const { step } = flow;

  return (
    <div className={wizardStyles.overlay} onClick={onClose}>
      <div
        className={wizardStyles.modal}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Adoptar un LP existente"
      >
        <header className={wizardStyles.header}>
          <div>
            <span className={wizardStyles.eyebrow}>LP Orchestrator</span>
            <h2 className={wizardStyles.title}>Adoptar un LP existente</h2>
            <p className={wizardStyles.desc}>
              El orquestador nace configurado con los datos de la posición. Solo decides la cobertura y el nombre. Sin firmas.
            </p>
          </div>
          <div className={wizardStyles.headerActions}>
            <button type="button" className={wizardStyles.closeBtn} onClick={onClose} aria-label="Cerrar">✕</button>
          </div>
        </header>

        {step !== ADOPT_STEP.DONE && <Stepper step={step} />}

        {step === ADOPT_STEP.POSITION && (
          <>
            <StepPosition flow={flow} networkOptions={options} />
            <footer className={wizardStyles.footer}>
              <button type="button" className={wizardStyles.btn} onClick={onClose}>Cancelar</button>
              <div className={wizardStyles.spacer} />
              <button
                type="button"
                className={wizardStyles.btnPrimary}
                onClick={() => flow.setStep(ADOPT_STEP.DETAILS)}
                disabled={!flow.selected}
              >
                Siguiente →
              </button>
            </footer>
          </>
        )}

        {step === ADOPT_STEP.DETAILS && flow.selected && (
          <>
            <StepDetails flow={flow} />
            <footer className={wizardStyles.footer}>
              <button type="button" className={wizardStyles.btn} onClick={() => flow.setStep(ADOPT_STEP.POSITION)}>← Atrás</button>
              {flow.detailsError && <span className={wizardStyles.errorText}>{flow.detailsError}</span>}
              <div className={wizardStyles.spacer} />
              <button
                type="button"
                className={wizardStyles.btnPrimary}
                onClick={() => flow.setStep(ADOPT_STEP.PROTECTION)}
                disabled={!!flow.detailsError}
              >
                Siguiente →
              </button>
            </footer>
          </>
        )}

        {step === ADOPT_STEP.PROTECTION && flow.selected && (
          <>
            <StepAdoptProtection flow={flow} accounts={accounts} />
            <footer className={wizardStyles.footer}>
              <button type="button" className={wizardStyles.btn} onClick={() => flow.setStep(ADOPT_STEP.DETAILS)}>← Atrás</button>
              <div className={wizardStyles.spacer} />
              <button
                type="button"
                className={wizardStyles.btnPrimary}
                onClick={flow.continueFromProtection}
                disabled={flow.preflightBusy}
              >
                {flow.preflightBusy ? 'Comprobando…' : 'Siguiente →'}
              </button>
            </footer>
          </>
        )}

        {step === ADOPT_STEP.REVIEW && flow.selected && (
          <>
            <StepReview flow={flow} />
            <footer className={wizardStyles.footer}>
              <button type="button" className={wizardStyles.btn} onClick={() => flow.setStep(ADOPT_STEP.PROTECTION)} disabled={flow.submitBusy}>← Atrás</button>
              <div className={wizardStyles.spacer} />
              <button type="button" className={wizardStyles.btnPrimary} onClick={flow.submit} disabled={flow.submitBusy}>
                {flow.submitBusy
                  ? 'Adoptando…'
                  : flow.protectionMode === 'new' ? 'Adoptar y cubrir' : 'Adoptar'}
              </button>
            </footer>
          </>
        )}

        {step === ADOPT_STEP.DONE && (
          <>
            <div className={wizardStyles.stepBody}>
              <div className={`${wizardStyles.card} ${wizardStyles.cardOk}`}>
                <h3 className={wizardStyles.lpTitle}>Orquestador creado</h3>
                <span className={wizardStyles.hint}>
                  «{flow.result?.orchestrator?.name || flow.form.name}» gestiona ahora el LP #{flow.selected?.position.identifier}.
                  Se está evaluando y la tarjeta mostrará el rango y la cobertura en unos segundos.
                </span>
              </div>
            </div>
            <footer className={wizardStyles.footer}>
              <div className={wizardStyles.spacer} />
              <button type="button" className={wizardStyles.btnPrimary} onClick={onClose}>Cerrar</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

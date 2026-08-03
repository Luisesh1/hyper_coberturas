import useUnifiedLpFlow, { UNIFIED_STEP } from './useUnifiedLpFlow';
import StepPoolSelection from '../../pages/UniswapPools/components/smart-create/StepPoolSelection';
import StepRangeConfig from '../../pages/UniswapPools/components/smart-create/StepRangeConfig';
import StepFunding from '../../pages/UniswapPools/components/smart-create/StepFunding';
import StepSigning from '../../pages/UniswapPools/components/smart-create/StepSigning';
import StepDone from '../../pages/UniswapPools/components/smart-create/StepDone';
import StepError from '../../pages/UniswapPools/components/smart-create/StepError';
import StepProtection from './steps/StepProtection';
import StepPlanReview from './steps/StepPlanReview';
import StepOutcome from './steps/StepOutcome';
import styles from './UnifiedLpWizard.module.css';

const { POOL, RANGE, FUNDING, REVIEW, SIGNING, ERROR, PROTECTION, OUTCOME } = UNIFIED_STEP;

function stepperItems(isOrchestrated) {
  const items = [
    { id: POOL, label: 'Pool' },
    { id: RANGE, label: 'Rango' },
    { id: FUNDING, label: 'Fondeo' },
  ];
  if (isOrchestrated) items.push({ id: PROTECTION, label: 'Cobertura' });
  items.push({ id: REVIEW, label: 'Revisión' });
  return items;
}

function Stepper({ items, currentIndex }) {
  return (
    <div className={styles.stepper} role="progressbar" aria-valuenow={currentIndex + 1} aria-valuemin={1} aria-valuemax={items.length}>
      {items.map((item, i) => (
        <div key={item.id} className={styles.stepItem}>
          <div className={`${styles.dot} ${i === currentIndex ? styles.dotOn : ''} ${i < currentIndex ? styles.dotDone : ''}`}>
            {i < currentIndex ? '✓' : i + 1}
          </div>
          <span className={`${styles.stepText} ${i === currentIndex ? styles.stepTextOn : ''}`}>{item.label}</span>
          {i < items.length - 1 && <div className={`${styles.line} ${i < currentIndex ? styles.lineDone : ''}`} />}
        </div>
      ))}
    </div>
  );
}

/**
 * Wizard único para crear una posición LP.
 *
 *   mode="standalone"   Pool → Rango → Fondeo → Revisión → Firma
 *   mode="orchestrated" Pool → Rango → Fondeo → Cobertura → Revisión → Firma
 *
 * Sustituye a CreateOrchestratorWizard + SmartCreatePoolModal, que pedían
 * red, versión, pool, fee y capital dos veces y definían el ancho del rango
 * en dos sitios sin conciliarlos.
 */
export default function UnifiedLpWizard({
  mode = 'orchestrated',
  wallet,
  defaults,
  meta,
  accounts = [],
  onClose,
  onCompleted,
  onCloseLp,
  onKeepWithoutProtection,
}) {
  const unified = useUnifiedLpFlow({ mode, wallet, defaults, onCompleted });
  const { flow, step, isOrchestrated } = unified;

  const networkOptions = Array.isArray(meta?.networks) && meta.networks.length
    ? meta.networks
    : [{ id: 'ethereum', label: 'Ethereum', versions: ['v3'] }];
  const selectedNetwork = networkOptions.find((item) => item.id === flow.network) || networkOptions[0];
  // Dos filtros distintos y ambos necesarios: la red puede no tener una de
  // las versiones (ofrecerla daría un "pool no encontrado" sin explicación),
  // y `meta` lista también v2, que el orquestador no gestiona — dejarla
  // elegible llevaría al usuario hasta Revisión para chocar contra el schema.
  const ORCHESTRABLE_VERSIONS = ['v3', 'v4'];
  const networkVersions = Array.isArray(selectedNetwork?.versions) && selectedNetwork.versions.length
    ? selectedNetwork.versions
    : ORCHESTRABLE_VERSIONS;
  const availableVersions = networkVersions.filter((v) => ORCHESTRABLE_VERSIONS.includes(v));

  const items = stepperItems(isOrchestrated);
  const currentIndex = Math.max(0, items.findIndex((item) => item.id === step));
  const isTerminal = step === OUTCOME || step === SIGNING || step === ERROR;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isOrchestrated ? 'Nuevo LP orquestado' : 'Nueva posición LP'}
      >
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>{isOrchestrated ? 'LP Orchestrator' : 'Creación guiada'}</span>
            <h2 className={styles.title}>{isOrchestrated ? 'Nuevo LP orquestado' : 'Nueva posición LP'}</h2>
            <p className={styles.desc}>
              {isOrchestrated
                ? 'Un solo flujo: eliges el pool, el rango y la cobertura, y firmas una vez. Nada se guarda hasta que el plan entero está listo.'
                : 'Define el pool, ajusta el rango, selecciona el capital y revisa el plan antes de firmar.'}
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Cerrar">✕</button>
        </header>

        {!isTerminal && <Stepper items={items} currentIndex={currentIndex} />}

        {flow.isBusy && (
          <section className={styles.section}>
            <div className={styles.loading}>
              <div className={styles.spinner} />
              <p>{flow.loadingMessage || 'Trabajando...'}</p>
            </div>
          </section>
        )}

        {!flow.isBusy && step === POOL && (
          <div className={styles.stepBody}>
            {/* En modo standalone la red y la versión las manda la página de
                Uniswap Pools; duplicar el control ahí sería una segunda fuente
                de verdad. En modo orquestado el wizard es el único dueño. */}
            {isOrchestrated && (
              <div className={styles.selectorRow}>
                <div className={styles.field}>
                  <label htmlFor="orch-network">Red</label>
                  <select
                    id="orch-network"
                    value={unified.network}
                    onChange={(e) => unified.handleNetworkChange(e.target.value, networkOptions)}
                  >
                    {networkOptions.map((n) => (
                      <option key={n.id} value={n.id}>{n.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="orch-version">Versión</label>
                  <select
                    id="orch-version"
                    value={unified.version}
                    onChange={(e) => unified.setVersion(e.target.value)}
                  >
                    {availableVersions.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {isOrchestrated && unified.version === 'v4' && (
              <p className={styles.hint}>
                En v4 solo son gestionables los pools <strong>sin hook y con tokens
                ERC-20</strong>: la gestión on-chain rechaza los hooks y el ETH
                nativo, así que un pool así se podría crear pero no rebalancear
                ni cerrar.
              </p>
            )}

            {isOrchestrated && (
              <div className={styles.field}>
                <label htmlFor="orch-name">Nombre del orquestador</label>
                <input
                  id="orch-name"
                  type="text"
                  value={unified.name}
                  onChange={(e) => unified.setName(e.target.value)}
                  placeholder="Se autocompleta desde el pool"
                  maxLength={255}
                />
                <span className={styles.hint}>Autocompletado desde el pool. Editable.</span>
              </div>
            )}
            <StepPoolSelection
              wallet={wallet}
              selectedNetwork={selectedNetwork}
              network={flow.network}
              version={flow.version}
              fee={flow.fee}
              setFee={flow.setFee}
              totalUsdTarget={flow.totalUsdTarget}
              setTotalUsdTarget={flow.setTotalUsdTarget}
              token0Address={flow.token0Address}
              setToken0Address={flow.setToken0Address}
              token1Address={flow.token1Address}
              setToken1Address={flow.setToken1Address}
              customToken0={flow.customToken0}
              setCustomToken0={flow.setCustomToken0}
              customToken1={flow.customToken1}
              setCustomToken1={flow.setCustomToken1}
              tokenOptions={flow.tokenOptions}
              error={flow.error}
              handleAnalyzePool={flow.handleAnalyzePool}
              hideContextTiles={isOrchestrated}
            />
          </div>
        )}

        {!flow.isBusy && step === RANGE && flow.suggestions && (
          <div className={styles.stepBody}>
            <StepRangeConfig
              suggestions={flow.suggestions}
              totalUsdTarget={flow.totalUsdTarget}
              rangeMode={flow.rangeMode}
              setRangeMode={flow.setRangeMode}
              selectedPreset={flow.selectedPreset}
              setSelectedPreset={flow.setSelectedPreset}
              customLowerPrice={flow.customLowerPrice}
              setCustomLowerPrice={flow.setCustomLowerPrice}
              customUpperPrice={flow.customUpperPrice}
              setCustomUpperPrice={flow.setCustomUpperPrice}
              customWeightToken0={flow.customWeightToken0}
              setCustomWeightToken0={flow.setCustomWeightToken0}
              activeRange={flow.activeRange}
              error={flow.error}
              handleReset={flow.handleReset}
              handleContinueToFunding={flow.handleContinueToFunding}
            />

            {isOrchestrated && (
              <section className={`${styles.card} ${styles.cardTeal}`}>
                <h4 className={styles.cardTitle}>Heredado por la estrategia</h4>
                <div className={styles.kv}>
                  <span>rangeWidthPct</span>
                  <strong>{unified.effectiveRangeWidthPct ?? '—'}</strong>
                </div>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={!!unified.strategy.rangeWidthDecoupled}
                    onChange={(e) => unified.setStrategy({
                      ...unified.strategy,
                      rangeWidthDecoupled: e.target.checked,
                      rangeWidthPct: e.target.checked
                        ? String(unified.derivedRangeWidthPct ?? '')
                        : unified.strategy.rangeWidthPct,
                    })}
                  />
                  Desacoplar del rango inicial
                </label>
                {unified.strategy.rangeWidthDecoupled && (
                  <div className={styles.field}>
                    <label htmlFor="range-width">Ancho para los rebalanceos (%)</label>
                    <input
                      id="range-width"
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={unified.strategy.rangeWidthPct}
                      onChange={(e) => unified.setStrategy({ ...unified.strategy, rangeWidthPct: e.target.value })}
                    />
                  </div>
                )}
                <span className={styles.hint}>
                  Los rebalanceos futuros replican el ancho que acabas de validar.
                </span>
              </section>
            )}
          </div>
        )}

        {!flow.isBusy && step === FUNDING && (
          <StepFunding
            selectedNetwork={selectedNetwork}
            network={flow.network}
            totalUsdTarget={flow.totalUsdTarget}
            fundingDiagnostics={flow.fundingDiagnostics}
            fundingIssue={flow.fundingIssue}
            fundingPlan={flow.fundingPlan}
            availableAssets={flow.availableAssets}
            assetSelections={flow.assetSelections}
            setAssetSelections={flow.setAssetSelections}
            setHasFundingEdits={flow.setHasFundingEdits}
            importTokenAddress={flow.importTokenAddress}
            setImportTokenAddress={flow.setImportTokenAddress}
            handleAddFundingImport={flow.handleAddFundingImport}
            maxSlippageBps={flow.maxSlippageBps}
            setMaxSlippageBps={flow.setMaxSlippageBps}
            error={flow.error}
            isBusy={flow.isBusy}
            setStep={flow.setStep}
            onClose={onClose}
            refreshFundingPlan={flow.refreshFundingPlan}
            handleApplyRecommended={flow.handleApplyRecommended}
            handleRetryFunding={flow.handleRetryFunding}
            handlePrepareReview={flow.handlePrepareReview}
          />
        )}

        {!flow.isBusy && step === PROTECTION && (
          <>
            <StepProtection
              protection={unified.protection}
              setProtection={unified.setProtection}
              accounts={accounts}
              capitalUsd={Number(flow.totalUsdTarget) || 0}
              rangeWidthPct={unified.effectiveRangeWidthPct}
              preflight={unified.preflight}
              preflightBusy={unified.preflightBusy}
              onRunPreflight={unified.runPreflight}
            />
            <footer className={styles.footer}>
              <button type="button" className={styles.btn} onClick={unified.backFromProtection}>← Atrás</button>
              <div className={styles.spacer} />
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={unified.handleContinueFromProtection}
                disabled={unified.preflightBusy}
              >
                {unified.preflightBusy ? 'Comprobando…' : 'Siguiente →'}
              </button>
            </footer>
          </>
        )}

        {!flow.isBusy && step === REVIEW && flow.prepareData && (
          <>
            <StepPlanReview
              plan={unified.buildPlan()}
              isOrchestrated={isOrchestrated}
              prepareData={flow.prepareData}
              preflight={unified.preflight}
              rangeWidthPct={unified.effectiveRangeWidthPct}
              reviewFundingAssets={flow.reviewFundingAssets}
              reviewSwapPlan={flow.reviewSwapPlan}
            />
            {flow.error && <div className={styles.errorText}>{flow.error}</div>}
            <footer className={styles.footer}>
              <button type="button" className={styles.btn} onClick={unified.backFromReview}>← Atrás</button>
              <div className={styles.spacer} />
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={unified.handleSignAndCreate}
                disabled={unified.commitBusy}
              >
                {unified.commitBusy
                  ? 'Confirmando…'
                  : `Firmar y crear — ${flow.prepareData.txPlan?.length || 0} firmas`}
              </button>
            </footer>
          </>
        )}

        {step === SIGNING && (
          <StepSigning
            prepareData={flow.prepareData}
            completedTxIndex={flow.completedTxIndex}
            currentTxIndex={flow.currentTxIndex}
            txHashes={flow.txHashes}
            explorerUrl={selectedNetwork?.explorerUrl || null}
            loadingMessage={unified.commitBusy ? 'Abriendo la cobertura y vinculando el orquestador…' : flow.loadingMessage}
          />
        )}

        {/* El éxito reusa StepDone: los links al explorador y el aviso de
            finalize parcial ya estaban resueltos ahí, y perderlos al unificar
            habría sido una regresión silenciosa. */}
        {step === OUTCOME && unified.outcome?.status === 'completed' && (
          <StepDone
            txHashes={flow.txHashes}
            prepareData={flow.prepareData}
            explorerUrl={selectedNetwork?.explorerUrl || null}
            onClose={onClose}
            warning={flow.error}
          />
        )}

        {step === OUTCOME && unified.outcome?.status !== 'completed' && (
          <StepOutcome
            outcome={unified.outcome}
            onClose={onClose}
            onRetryProtection={unified.resetOutcome}
            onKeepWithoutProtection={onKeepWithoutProtection}
            onCloseLp={onCloseLp}
          />
        )}

        {step === ERROR && (
          <StepError
            error={flow.error}
            completedTxIndex={flow.completedTxIndex}
            txHashes={flow.txHashes}
            prepareData={flow.prepareData}
            explorerUrl={selectedNetwork?.explorerUrl || null}
            failedTxLabel={flow.failedTxLabel}
            handleReset={flow.handleReset}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

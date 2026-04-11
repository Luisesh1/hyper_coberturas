import styles from './SmartCreatePoolModal.module.css';
import { STEP } from './smart-create/constants';
import useSmartCreateFlow from './smart-create/useSmartCreateFlow';
import StepPill from './smart-create/StepPill';
import StepPoolSelection from './smart-create/StepPoolSelection';
import StepRangeConfig from './smart-create/StepRangeConfig';
import StepFunding from './smart-create/StepFunding';
import StepReview from './smart-create/StepReview';
import StepSigning from './smart-create/StepSigning';
import StepDone from './smart-create/StepDone';
import StepError from './smart-create/StepError';

export default function SmartCreatePoolModal({
  wallet,
  sendTransaction,
  waitForTransactionReceipt,
  defaults,
  meta,
  onClose,
  onFinalized,
}) {
  const flow = useSmartCreateFlow({ wallet, defaults, onFinalized });

  const networkOptions = Array.isArray(meta?.networks) ? meta.networks : [{ id: 'ethereum', label: 'Ethereum', versions: ['v3'] }];
  const selectedNetwork = networkOptions.find((item) => item.id === flow.network) || networkOptions[0];
  const explorerUrl = selectedNetwork?.explorerUrl || null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Crear posición LP automáticamente"
      >
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Creación guiada</span>
            <h2 className={styles.title}>Nueva posición LP</h2>
            <p className={styles.desc}>
              Define el pool, ajusta el rango, selecciona el capital fuente y revisa el plan completo antes de firmar.
            </p>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className={styles.stepper}>
          <StepPill label="1. Pool" active={flow.step === STEP.POOL} done={[STEP.RANGE, STEP.FUNDING, STEP.REVIEW, STEP.SIGNING, STEP.DONE].includes(flow.step)} />
          <StepPill label="2. Rango" active={flow.step === STEP.RANGE} done={[STEP.FUNDING, STEP.REVIEW, STEP.SIGNING, STEP.DONE].includes(flow.step)} />
          <StepPill label="3. Fondeo" active={flow.step === STEP.FUNDING} done={[STEP.REVIEW, STEP.SIGNING, STEP.DONE].includes(flow.step)} />
          <StepPill label="4. Review" active={flow.step === STEP.REVIEW || flow.step === STEP.SIGNING || flow.step === STEP.DONE} done={[STEP.SIGNING, STEP.DONE].includes(flow.step)} />
        </div>

        {flow.isBusy && (
          <section className={styles.section}>
            <div className={styles.loading}>
              <div className={styles.spinner} />
              <p>{flow.loadingMessage || 'Trabajando...'}</p>
            </div>
          </section>
        )}

        {!flow.isBusy && flow.step === STEP.POOL && (
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
          />
        )}

        {!flow.isBusy && flow.step === STEP.RANGE && flow.suggestions && (
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
        )}

        {!flow.isBusy && flow.step === STEP.FUNDING && (
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
            handlePrepareReview={flow.handlePrepareReview}
          />
        )}

        {!flow.isBusy && flow.step === STEP.REVIEW && flow.prepareData && (
          <StepReview
            wallet={wallet}
            selectedNetwork={selectedNetwork}
            network={flow.network}
            version={flow.version}
            fee={flow.fee}
            activeRange={flow.activeRange}
            prepareData={flow.prepareData}
            reviewFundingAssets={flow.reviewFundingAssets}
            reviewSwapPlan={flow.reviewSwapPlan}
            error={flow.error}
            setStep={flow.setStep}
            handleExecute={flow.handleExecute}
          />
        )}

        {flow.step === STEP.SIGNING && (
          <StepSigning
            prepareData={flow.prepareData}
            completedTxIndex={flow.completedTxIndex}
            currentTxIndex={flow.currentTxIndex}
            txHashes={flow.txHashes}
            explorerUrl={explorerUrl}
            loadingMessage={flow.loadingMessage}
          />
        )}

        {flow.step === STEP.DONE && (
          <StepDone
            txHashes={flow.txHashes}
            prepareData={flow.prepareData}
            explorerUrl={explorerUrl}
            onClose={onClose}
          />
        )}

        {flow.step === STEP.ERROR && (
          <StepError
            error={flow.error}
            completedTxIndex={flow.completedTxIndex}
            txHashes={flow.txHashes}
            prepareData={flow.prepareData}
            explorerUrl={explorerUrl}
            failedTxLabel={flow.failedTxLabel}
            handleReset={flow.handleReset}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

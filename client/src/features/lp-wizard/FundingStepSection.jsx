import StepFunding from '../../pages/UniswapPools/components/smart-create/StepFunding';
import StepProtection from './steps/StepProtection';
import CrossChainFundingPanel from '../cross-chain-funding/CrossChainFundingPanel';
import BringFundsStep from '../cross-chain-funding/BringFundsStep';
import useBringFunds from '../cross-chain-funding/useBringFunds';
import { networkLabelsFrom } from '../cross-chain-funding/networks';
import styles from './UnifiedLpWizard.module.css';

function BringFunds({ crossChain, wallet, protectionSlot }) {
  const run = useBringFunds({ planId: crossChain.planId, wallet });
  return (
    <BringFundsStep
      plan={run.plan}
      networkLabels={networkLabelsFrom(crossChain.funding.analysis)}
      running={run.running}
      activeOrder={run.activeOrder}
      confirm={run.confirm}
      error={run.error}
      onStart={run.start}
      onAnswerConfirm={run.answerConfirm}
      onSpeedUp={run.speedUp}
      onSkip={run.skip}
      onContinueWithArrived={run.continueWithArrived}
      onDiscard={run.discard}
      onContinueToLp={crossChain.finish}
      protectionSlot={protectionSlot}
    />
  );
}

/**
 * Paso Fondeo del asistente: el fondeo de la red del LP de siempre más el
 * panel multi-red y, mientras hay un plan cross-chain en curso, su ejecución.
 * Con un plan en vuelo la cobertura se puede ir configurando aquí mismo.
 */
export default function FundingStepSection({ flow, unified, crossChain, selectedNetwork, onClose, wallet, accounts, ownerWalletAddress }) {
  if (crossChain.bringing) {
    const protectionSlot = unified.isOrchestrated ? (
      <details className={styles.parallelProtection}>
        <summary>Configurar la cobertura mientras llegan los fondos</summary>
        <StepProtection
          protection={unified.protection}
          setProtection={unified.setProtection}
          accounts={accounts}
          lpWalletAddress={ownerWalletAddress}
          defaultLeverage="10"
          capitalUsd={crossChain.funding.analysis?.deployableUsd || 0}
          rangeWidthPct={unified.effectiveRangeWidthPct}
          currentPrice={flow.suggestions?.currentPrice}
          rangeLowerPrice={flow.activeRange?.rangeLowerPrice}
          rangeUpperPrice={flow.activeRange?.rangeUpperPrice}
          preflight={unified.preflight}
          preflightBusy={unified.preflightBusy}
          onRunPreflight={unified.runPreflight}
        />
      </details>
    ) : null;
    return <BringFunds crossChain={crossChain} wallet={wallet} protectionSlot={protectionSlot} />;
  }

  const { funding } = crossChain;
  return (
    <>
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
      {funding.available && (
        <div className={styles.stepBody}>
          {crossChain.startError && <p className={styles.errorText} role="alert">{crossChain.startError}</p>}
          <CrossChainFundingPanel
            analysis={funding.analysis}
            loading={funding.loading}
            error={funding.error}
            profile={funding.profile}
            onProfileChange={funding.setProfile}
            forcedSources={funding.forcedSources}
            disabledSources={funding.disabledSources}
            onToggleForced={funding.toggleForced}
            onToggleDisabled={funding.toggleDisabled}
            onUseRecommended={funding.resetSelection}
            onBringFunds={crossChain.bringFunds}
            canExecute={funding.canExecute}
            busy={crossChain.busy}
          />
        </div>
      )}
    </>
  );
}

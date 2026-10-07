import wizardStyles from '../lp-wizard/UnifiedLpWizard.module.css';
import styles from './AdoptLpWizard.module.css';
import ResumePlanCard from '../cross-chain-funding/ResumePlanCard';

/**
 * Primer paso de «Crear orquestador»: de dónde sale el LP. Crear uno nuevo
 * lleva al asistente con firma del mint; adoptar uno de la wallet, al
 * asistente sin firmas que precarga la configuración desde la posición.
 */
export default function CreateOrchestratorChooser({ onCreateNew, onAdoptExisting, onClose, walletAddress = '', onResumeFunding }) {
  return (
    <div className={wizardStyles.overlay} onClick={onClose}>
      <div
        className={wizardStyles.modal}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Nuevo orquestador"
      >
        <header className={wizardStyles.header}>
          <div>
            <span className={wizardStyles.eyebrow}>LP Orchestrator</span>
            <h2 className={wizardStyles.title}>Nuevo orquestador</h2>
            <p className={wizardStyles.desc}>¿De dónde sale el LP?</p>
          </div>
          <div className={wizardStyles.headerActions}>
            <button type="button" className={wizardStyles.closeBtn} onClick={onClose} aria-label="Cerrar">✕</button>
          </div>
        </header>
        <div className={wizardStyles.stepBody}>
          <ResumePlanCard walletAddress={walletAddress} onResume={onResumeFunding} />
          <div className={styles.modes}>
            <button type="button" className={styles.mode} onClick={onCreateNew}>
              <strong>Crear un LP nuevo</strong>
              <span>Pool → Rango → Fondeo → Cobertura → Revisión, con firma del mint.</span>
            </button>
            <button type="button" className={styles.mode} onClick={onAdoptExisting}>
              <strong>Adoptar un LP de mi wallet</strong>
              <span>Para una posición que ya tienes en Uniswap. Sin firmas: el orquestador se configura con los datos de la posición.</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

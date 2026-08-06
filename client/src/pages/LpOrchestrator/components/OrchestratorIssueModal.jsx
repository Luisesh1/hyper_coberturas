import { getOrchestratorIssue } from './orchestratorIssueState';
import ModalShell from '../../../components/shared/ModalShell/ModalShell';
import ui from '../../../styles/modal-controls.module.css';

const TONE_BADGE = {
  urgent: ui.badgeDanger,
  warn: ui.badgeWarn,
};

export default function OrchestratorIssueModal({
  orchestrator,
  isResolving = false,
  onClose,
  onResolve,
  onShowLog,
}) {
  const issue = getOrchestratorIssue(orchestrator);

  if (!issue || !orchestrator) return null;

  return (
    <ModalShell
      eyebrow={(
        <span className={`${ui.badge} ${TONE_BADGE[issue.tone] || ui.badgeWarn}`}>
          {issue.chipLabel}
        </span>
      )}
      title={issue.title}
      desc={`${orchestrator.name} · #${orchestrator.id}`}
      ariaLabel={issue.title}
      size="sm"
      onClose={onClose}
      closeDisabled={isResolving}
      footer={(
        // Navegación a la izquierda, confirmación a la derecha: "Ver bitácora"
        // no es una acción de cierre y no debe competir con la primaria.
        <div className={ui.footerSplit}>
          <button
            type="button"
            className={ui.btnGhost}
            onClick={() => onShowLog?.(orchestrator)}
            disabled={isResolving}
          >
            Ver bitácora
          </button>
          <div className={ui.footerGroup}>
            <button type="button" className={ui.btnSecondary} onClick={onClose} disabled={isResolving}>
              Cerrar
            </button>
            {/* Jerarquía fija: el tono del issue se expresa en el badge de la
                cabecera, no cambiando el color del botón primario. */}
            <button
              type="button"
              className={ui.btnPrimary}
              onClick={() => onResolve?.(orchestrator)}
              disabled={isResolving}
            >
              {isResolving ? 'Resolviendo…' : issue.resolveLabel}
            </button>
          </div>
        </div>
      )}
    >
      <p className={ui.sectionHint}>{issue.summary}</p>

      {!!issue.details?.length && (
        <div className={ui.grid2}>
          {issue.details.map((item) => (
            <div key={`${item.label}:${item.value}`} className={ui.metricCard}>
              <span className={ui.metricLabel}>{item.label}</span>
              <span className={ui.metricValue}>{item.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className={ui.notice}>
        El intento de solución fuerza una reconciliación del LP y luego una reevaluación
        inmediata del orquestador.
      </div>
    </ModalShell>
  );
}

import { getOrchestratorIssue } from './orchestratorIssueState';

/**
 * Severidad de un orquestador, para el riel de color de la tarjeta y para el
 * orden de la cola de acciones.
 *
 * Se apoya en `getOrchestratorIssue` en vez de reimplementar el diagnóstico:
 * esa función ya decide qué está mal y con qué tono, y tener dos criterios
 * distintos para "esto necesita atención" es exactamente cómo el riel y el
 * banner terminarían contradiciéndose.
 */
const RANK = { urgent: 0, warn: 1, ok: 2, idle: 3 };

export function getOrchestratorSeverity(orchestrator, now = Date.now()) {
  if (!orchestrator) return 'idle';
  const issue = getOrchestratorIssue(orchestrator, now);
  if (issue?.tone === 'urgent') return 'urgent';
  if (issue?.tone === 'warn') return 'warn';
  if (!orchestrator.activePositionIdentifier) return 'idle';
  return 'ok';
}

/**
 * Construye la cola de trabajo: sólo lo que pide algo de una persona, lo más
 * grave primero. Un orquestador sano NO aparece — la cola vale justamente por
 * lo que deja afuera.
 */
export function buildActionQueue(orchestrators = [], now = Date.now()) {
  return orchestrators
    .map((orchestrator) => {
      const issue = getOrchestratorIssue(orchestrator, now);
      if (!issue) return null;
      return {
        id: orchestrator.id,
        orchestrator,
        issue,
        severity: issue.tone === 'urgent' ? 'urgent' : 'warn',
        pair: `${orchestrator.token0Symbol || '?'}/${orchestrator.token1Symbol || '?'}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const bySeverity = RANK[a.severity] - RANK[b.severity];
      if (bySeverity !== 0) return bySeverity;
      // Empate: el más viejo sin atender primero, para que la cola no se
      // reordene sola cada vez que uno se reevalúa.
      return Number(a.id) - Number(b.id);
    });
}

/**
 * Orden de la grilla: lo que necesita atención sube. Dentro de cada nivel se
 * conserva el orden que ya traía la lista, así el usuario no ve las tarjetas
 * saltar de lugar en cada refresco.
 */
export function sortBySeverity(orchestrators = [], now = Date.now()) {
  return orchestrators
    .map((orchestrator, index) => ({ orchestrator, index, severity: getOrchestratorSeverity(orchestrator, now) }))
    .sort((a, b) => {
      const bySeverity = RANK[a.severity] - RANK[b.severity];
      return bySeverity !== 0 ? bySeverity : a.index - b.index;
    })
    .map((entry) => entry.orchestrator);
}

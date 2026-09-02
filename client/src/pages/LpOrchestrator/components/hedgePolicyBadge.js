/**
 * Qué cobertura está corriendo AHORA sobre este orquestador.
 *
 * La fuente es `activeHedge`, que el servidor arma leyendo la protección
 * vinculada — no `protectionConfig`, que es la intención guardada en el
 * orquestador y no vuelve a tocar una protección ya creada: editarla deja el
 * formulario diciendo una cosa y el hedge haciendo otra durante todo el
 * tiempo que dure ese LP.
 *
 * Y aun dentro de la protección, la política declarada no es la que ejecuta:
 * una declarada con intención `shadow` se simula, y quien rebalancea de
 * verdad sigue siendo `legacy_zones_v1`. Esa diferencia es justamente lo que
 * el encabezado tiene que dejar de esconder, así que cuando aparece, el chip
 * cambia de tono en vez de mostrar el nombre bonito.
 */

export const HEDGE_POLICY_LABELS = {
  legacy_zones_v1: 'Zonas legacy',
  net_profit_v1: 'Net profit',
  net_profit_v2: 'Net profit V2',
  range_exit_v1: 'Borde de rango',
};

export function hedgePolicyLabel(policyVersion) {
  if (!policyVersion) return 'desconocida';
  return HEDGE_POLICY_LABELS[policyVersion] || policyVersion;
}

const PROTECTION_STATUS_LABELS = {
  inactive: 'desactivada',
  stopped: 'detenida',
  error: 'en error',
};

export function getHedgePolicyBadge(orchestrator) {
  if (!orchestrator) return null;

  const wantsProtection = Boolean(orchestrator.protectionConfig)
    && orchestrator.protectionConfig.enabled !== false;
  const hedge = orchestrator.activeHedge || null;

  // Sin protección vinculada no hay nada corriendo. Se dice igual, y no se
  // omite el chip: "no aparece" se lee como "no me fijé", y el hueco es
  // exactamente donde antes se asumía que había cobertura.
  if (!hedge) {
    return wantsProtection
      ? {
        text: 'Sin cobertura',
        tone: 'urgent',
        title: 'Hay cobertura configurada pero ninguna protección vinculada: el LP está expuesto al movimiento del precio.',
      }
      : {
        text: 'Sin cobertura',
        tone: 'muted',
        title: 'Este orquestador opera el LP en solitario, sin cobertura delta-neutral.',
      };
  }

  const liveLabel = hedgePolicyLabel(hedge.livePolicy);

  if (hedge.status && hedge.status !== 'active') {
    return {
      text: `${liveLabel} · detenida`,
      tone: 'urgent',
      title: `La protección vinculada está ${PROTECTION_STATUS_LABELS[hedge.status] || `en estado "${hedge.status}"`}: no está cubriendo el LP.`,
    };
  }

  // La declarada corre en sombra y la que mueve el hedge es otra. Va primero
  // la que ejecuta —es la respuesta a "qué está corriendo"— y la elegida
  // detrás, con su estado. Las dos en el texto y no solo en el color: el ámbar
  // no se ve si el ámbar no se distingue.
  if (hedge.declaredPolicy && hedge.declaredPolicy !== hedge.livePolicy) {
    const declaredLabel = hedgePolicyLabel(hedge.declaredPolicy);
    return {
      text: `${liveLabel} · ${declaredLabel} en sombra`,
      tone: 'warn',
      title: `El hedge rebalancea con ${liveLabel}. La política elegida (${declaredLabel}) corre en sombra: se mide, pero no toca la posición.`,
      shadowOf: hedge.declaredPolicy,
    };
  }

  return {
    text: liveLabel,
    tone: 'ok',
    title: `El hedge delta-neutral rebalancea con la política ${liveLabel}.`,
  };
}

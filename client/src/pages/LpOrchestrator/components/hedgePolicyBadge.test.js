import { describe, expect, it } from 'vitest';
import { getHedgePolicyBadge, hedgePolicyLabel } from './hedgePolicyBadge';

const CON_COBERTURA = {
  protectionConfig: { enabled: true, accountId: 1, policyVersion: 'net_profit_v1' },
  activeProtectedPoolId: 12,
};

describe('getHedgePolicyBadge', () => {
  it('nombra la política que ejecuta', () => {
    const badge = getHedgePolicyBadge({
      ...CON_COBERTURA,
      activeHedge: {
        status: 'active',
        declaredPolicy: 'net_profit_v1',
        executionIntent: 'live',
        livePolicy: 'net_profit_v1',
      },
    });
    expect(badge).toMatchObject({ text: 'Net profit', tone: 'ok' });
  });

  it('con la elegida en sombra, muestra la que REALMENTE rebalancea', () => {
    // El caso que motiva el chip: el formulario dice "Net profit" y el hedge
    // se mueve con las zonas legacy. Mostrar la declarada seria repetir la
    // mentira en un lugar mas.
    const badge = getHedgePolicyBadge({
      ...CON_COBERTURA,
      activeHedge: {
        status: 'active',
        declaredPolicy: 'net_profit_v1',
        executionIntent: 'shadow',
        livePolicy: 'legacy_zones_v1',
      },
    });
    // Las dos politicas en el TEXTO: la que ejecuta primero. Si la diferencia
    // viviera solo en el color, se pierde en cuanto el ambar no se distingue.
    expect(badge.text).toBe('Zonas legacy · Net profit en sombra');
    expect(badge.tone).toBe('warn');
    expect(badge.title).toContain('Net profit');
    expect(badge.title).toContain('sombra');
  });

  it('ignora protectionConfig: manda la protección vinculada', () => {
    // Editar la configuracion NO recrea la proteccion. Un orquestador que
    // pidio borde de rango pero corre con la proteccion vieja tiene que decir
    // lo que corre, no lo que se pidio.
    const badge = getHedgePolicyBadge({
      ...CON_COBERTURA,
      protectionConfig: { enabled: true, policyVersion: 'range_exit_v1' },
      activeHedge: {
        status: 'active',
        declaredPolicy: 'legacy_zones_v1',
        executionIntent: 'live',
        livePolicy: 'legacy_zones_v1',
      },
    });
    expect(badge.text).toBe('Zonas legacy');
    expect(badge.tone).toBe('ok');
  });

  it('protección configurada pero no vinculada es urgente', () => {
    const badge = getHedgePolicyBadge({ ...CON_COBERTURA, activeProtectedPoolId: null, activeHedge: null });
    expect(badge).toMatchObject({ text: 'Sin cobertura', tone: 'urgent' });
  });

  it('sin cobertura configurada no alarma, pero lo dice igual', () => {
    const badge = getHedgePolicyBadge({ protectionConfig: { enabled: false }, activeHedge: null });
    expect(badge).toMatchObject({ text: 'Sin cobertura', tone: 'muted' });
  });

  it('una protección vinculada pero no activa no está cubriendo', () => {
    const badge = getHedgePolicyBadge({
      ...CON_COBERTURA,
      activeHedge: {
        status: 'inactive',
        declaredPolicy: 'net_profit_v1',
        executionIntent: 'live',
        livePolicy: 'net_profit_v1',
      },
    });
    expect(badge.tone).toBe('urgent');
    expect(badge.text).toContain('detenida');
  });

  it('una política que este cliente no conoce se muestra cruda, no vacía', () => {
    expect(hedgePolicyLabel('policy_del_futuro_v9')).toBe('policy_del_futuro_v9');
    expect(hedgePolicyLabel(null)).toBe('desconocida');
  });
});

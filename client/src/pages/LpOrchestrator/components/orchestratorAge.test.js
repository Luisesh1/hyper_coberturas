import { describe, expect, it } from 'vitest';
import { formatOrchestratorAge, orchestratorAgeMs } from './orchestratorAge';

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

describe('formatOrchestratorAge', () => {
  it('usa dos unidades como mucho, y sólo cuando la segunda aporta', () => {
    expect(formatOrchestratorAge(6 * DIA + 4 * HORA)).toBe('6d 4h');
    expect(formatOrchestratorAge(6 * DIA)).toBe('6d');
    // Con días de por medio los minutos ya no dicen nada.
    expect(formatOrchestratorAge(6 * DIA + 37 * MIN)).toBe('6d');
    expect(formatOrchestratorAge(3 * HORA + 12 * MIN)).toBe('3h 12m');
    expect(formatOrchestratorAge(3 * HORA)).toBe('3h');
    expect(formatOrchestratorAge(45 * MIN)).toBe('45m');
  });

  it('un orquestador recién creado no muestra 0m', () => {
    // "0m" se lee como un dato roto; "< 1m" dice lo mismo y es cierto.
    expect(formatOrchestratorAge(20_000)).toBe('< 1m');
  });

  it('sin edad utilizable devuelve un guion, no NaN', () => {
    expect(formatOrchestratorAge(null)).toBe('—');
    expect(formatOrchestratorAge(-5)).toBe('—');
    expect(formatOrchestratorAge('ayer')).toBe('—');
  });
});

describe('orchestratorAgeMs', () => {
  it('mide desde createdAt', () => {
    const now = 1_700_000_000_000;
    expect(orchestratorAgeMs(now - 2 * DIA, now)).toBe(2 * DIA);
  });

  it('una fecha ausente o futura no es una edad', () => {
    const now = 1_700_000_000_000;
    // El reloj del cliente puede ir atrasado respecto del servidor: antes que
    // dibujar una edad negativa, no se dibuja nada.
    expect(orchestratorAgeMs(now + 60_000, now)).toBeNull();
    expect(orchestratorAgeMs(null, now)).toBeNull();
    expect(orchestratorAgeMs(0, now)).toBeNull();
  });
});

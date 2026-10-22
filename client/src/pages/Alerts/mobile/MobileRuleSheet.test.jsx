import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MobileRuleSheet from './MobileRuleSheet';

const SQZ = {
  indicatorType: 'sqzmom',
  indicatorParams: {
    length: 20, mult: 2, lengthKC: 20, multKC: 1.5, useTrueRange: true,
    normalBandLength: 100, normalBandSigma: 2,
  },
  timeframe: '1h',
  operandSeries: 'sqzMomentum',
  operator: 'momentum_redirect_bullish',
  operand: { kind: 'none' },
};

const RULE = {
  id: 'r-1',
  label: 'direccionalidad alcista',
  weight: 1,
  joiners: [],
  conditions: [SQZ],
};

function setup(overrides = {}) {
  const props = {
    open: true,
    index: 0,
    rule: RULE,
    isNew: false,
    canDelete: true,
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  const utils = render(<MobileRuleSheet {...props} />);
  return { props, ...utils };
}

describe('MobileRuleSheet', () => {
  it('no pinta nada cerrada', () => {
    setup({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('abre como diálogo con «Regla N» enfocado', () => {
    setup({ index: 2 });
    const dialog = screen.getByRole('dialog', { name: 'Regla 3' });
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Regla 3' }));
  });

  it('«Aplicar regla» llama a onApply con los cambios del borrador', () => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText('Etiqueta en Telegram'), { target: { value: 'nueva etiqueta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Subir peso' }));
    fireEvent.click(screen.getByRole('button', { name: '4h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    expect(props.onApply).toHaveBeenCalledTimes(1);
    const applied = props.onApply.mock.calls[0][0];
    expect(applied.label).toBe('nueva etiqueta');
    expect(applied.weight).toBe(1.5);
    expect(applied.conditions[0].timeframe).toBe('4h');
    // El original no se toca: se edita una copia.
    expect(RULE.label).toBe('direccionalidad alcista');
    expect(RULE.conditions[0].timeframe).toBe('1h');
  });

  it('el peso baja de 0,5 en 0,5 y no pasa de 0', () => {
    const { props } = setup({ rule: { ...RULE, weight: 0.5 } });
    const down = screen.getByRole('button', { name: 'Bajar peso' });
    fireEvent.click(down);
    expect(down.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    expect(props.onApply.mock.calls[0][0].weight).toBe(0);
  });

  it('la ✕ descarta sin aplicar', () => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText('Etiqueta en Telegram'), { target: { value: 'otra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Descartar cambios' }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('Escape descarta', () => {
    const { props } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('la papelera llama a onDelete', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar regla' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('sin canDelete la papelera está deshabilitada', () => {
    const { props } = setup({ canDelete: false });
    const trash = screen.getByRole('button', { name: 'Eliminar regla' });
    expect(trash.disabled).toBe(true);
    fireEvent.click(trash);
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('los parámetros empiezan plegados con un resumen y se despliegan', () => {
    setup();
    const toggle = screen.getByRole('button', { name: /Parámetros del indicador/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('BB 20/2 · KC 20/1,5');
    expect(toggle.textContent).toContain('sí');
    expect(screen.queryByLabelText('BB periodo')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('BB periodo')).toBeTruthy();
    // Los parámetros solo visuales siguen ocultos.
    expect(screen.queryByLabelText('Mostrar linea media')).toBeNull();
  });

  it('la temporalidad es un grupo de botones y «…» muestra 1m, 1w y 1M', () => {
    const { props } = setup();
    expect(screen.getByRole('button', { name: '1h' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '1D' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '1w' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Más temporalidades' }));
    expect(screen.getByRole('button', { name: '1m' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1M' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1w' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    expect(props.onApply.mock.calls[0][0].conditions[0].timeframe).toBe('1w');
  });

  it('«+ Condición «O»» añade una condición unida con or', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Condición «O»' }));
    expect(screen.getByRole('heading', { name: 'Condición 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    const applied = props.onApply.mock.calls[0][0];
    expect(applied.conditions).toHaveLength(2);
    expect(applied.joiners).toEqual(['or']);
  });

  it('«+ Condición «Y»» une con and y «Quitar condición» aparece con más de una', () => {
    const { props } = setup();
    expect(screen.queryByRole('button', { name: /Quitar condición/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Condición «Y»' }));
    const removes = screen.getAllByRole('button', { name: /Quitar condición/ });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    const applied = props.onApply.mock.calls[0][0];
    expect(applied.conditions).toHaveLength(1);
    expect(applied.conditions[0].indicatorType).toBe('rsi');
    expect(applied.joiners).toEqual([]);
  });

  it('cambiar el indicador reinicia parámetros y serie, como en escritorio', () => {
    const { props } = setup();
    const card = screen.getByRole('group', { name: 'Condición 1' });
    fireEvent.change(within(card).getByLabelText('Indicador'), { target: { value: 'macd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    const c = props.onApply.mock.calls[0][0].conditions[0];
    expect(c.indicatorType).toBe('macd');
    expect(c.operandSeries).toBe('macd');
    expect(c.indicatorParams).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(c.operator).toBe('<');
  });

  it('el operador y el operando constante se editan a todo el ancho', () => {
    const rule = { ...RULE, conditions: [{ indicatorType: 'rsi', indicatorParams: { length: 14 }, timeframe: '15m', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 } }] };
    const { props } = setup({ rule });
    fireEvent.change(screen.getByLabelText('Condición'), { target: { value: '>' } });
    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    const c = props.onApply.mock.calls[0][0].conditions[0];
    expect(c.operator).toBe('>');
    expect(c.operand).toEqual({ kind: 'constant', value: 70 });
  });

  it('se puede cambiar el «Y»/«O» entre condiciones', () => {
    const rule = { ...RULE, conditions: [SQZ, SQZ], joiners: ['and'] };
    const { props } = setup({ rule });
    const joiner = screen.getByRole('group', { name: 'Unión entre condición 1 y 2' });
    expect(within(joiner).getByRole('button', { name: 'Y' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(joiner).getByRole('button', { name: 'O' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    expect(props.onApply.mock.calls[0][0].joiners).toEqual(['or']);
  });

  it('Tab y Mayús+Tab dan la vuelta dentro de la hoja', () => {
    render(<button type="button">fuera</button>);
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Regla 1' });
    const close = within(dialog).getByRole('button', { name: 'Descartar cambios' });
    const apply = within(dialog).getByRole('button', { name: 'Aplicar regla' });
    apply.focus();
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(apply);
    // Con el foco fuera de la hoja, Tab lo devuelve dentro.
    screen.getByRole('button', { name: 'fuera' }).focus();
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    // En medio de la hoja, Tab sigue su curso normal.
    const label = within(dialog).getByLabelText('Etiqueta en Telegram');
    label.focus();
    const ev = fireEvent.keyDown(label, { key: 'Tab' });
    expect(ev).toBe(true);
    expect(document.activeElement).toBe(label);
  });

  it('quitar una condición no pasa su estado plegado a la siguiente y el payload no lleva claves locales', () => {
    const rsi = { indicatorType: 'rsi', indicatorParams: { length: 14 }, timeframe: '15m', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 } };
    const { props } = setup({ rule: { ...RULE, conditions: [SQZ, rsi], joiners: ['and'] } });
    const first = screen.getByRole('group', { name: 'Condición 1' });
    fireEvent.click(within(first).getByRole('button', { name: /Parámetros del indicador/ }));
    expect(within(first).getByRole('button', { name: /Parámetros del indicador/ }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Quitar condición 1' }));
    const remaining = screen.getByRole('group', { name: 'Condición 1' });
    expect(within(remaining).getByLabelText('Indicador').value).toBe('rsi');
    expect(within(remaining).getByRole('button', { name: /Parámetros del indicador/ }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    const applied = props.onApply.mock.calls[0][0];
    expect(applied.conditions).toEqual([rsi]);
    expect(applied.joiners).toEqual([]);
  });

  it('el payload aplicado conserva la forma de la regla', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Condición «Y»' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar regla' }));
    const applied = props.onApply.mock.calls[0][0];
    expect(Object.keys(applied).sort()).toEqual(Object.keys(RULE).sort());
    for (const c of applied.conditions) expect(Object.keys(c).sort()).toEqual(Object.keys(SQZ).sort());
  });
});

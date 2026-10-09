import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IndicatorSettingsForm from './IndicatorSettingsForm';
import { makeIndicatorEntry } from '../indicators/catalog';

// Reproduce el uso real del modal: el padre guarda el indicador y se lo
// devuelve al formulario en cada onChange.
function renderForm(type, overrides = {}) {
  const initial = { ...makeIndicatorEntry(type), ...overrides };
  const onChange = vi.fn();
  function Harness() {
    const [indicator, setIndicator] = useState(initial);
    return (
      <IndicatorSettingsForm
        indicator={indicator}
        onChange={(next) => { onChange(next); setIndicator(next); }}
      />
    );
  }
  render(<Harness />);
  return { onChange, last: () => onChange.mock.calls.at(-1)?.[0] };
}

describe('IndicatorSettingsForm', () => {
  it('no pinta nada para un tipo desconocido', () => {
    const { container } = render(<IndicatorSettingsForm indicator={{ type: 'nope', params: {} }} onChange={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('agrupa en secciones: parámetros y estilo en un overlay', () => {
    renderForm('sma');
    expect(screen.getByRole('group', { name: 'Parámetros' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Estilo' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Visibilidad' })).toBeNull();
  });

  it('separa los interruptores "Mostrar ..." en Visibilidad y no muestra Estilo en subpanel', () => {
    renderForm('sqzmom');
    const visibility = screen.getByRole('group', { name: 'Visibilidad' });
    expect(visibility.contains(screen.getByRole('switch', { name: 'Mostrar linea media' }))).toBe(true);
    const params = screen.getByRole('group', { name: 'Parámetros' });
    expect(params.contains(screen.getByRole('switch', { name: 'Usar True Range' }))).toBe(true);
    expect(screen.queryByRole('group', { name: 'Estilo' })).toBeNull();
  });

  it('el botón + suma el paso decimal sin error de coma flotante', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sqzmom', { params: { ...makeIndicatorEntry('sqzmom').params, normalBandSigma: 0.2 } });
    await user.click(screen.getByRole('button', { name: 'Aumentar Sigma extremo' }));
    expect(last().params.normalBandSigma).toBe(0.3);
    expect(screen.getByRole('textbox', { name: 'Sigma extremo' }).value).toBe('0.3');
  });

  it('el botón − resta el paso y se desactiva en el mínimo', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sma', { params: { length: 3 } });
    const minus = screen.getByRole('button', { name: 'Disminuir Periodo' });
    await user.click(minus);
    expect(last().params.length).toBe(2);
    expect(minus.disabled).toBe(true);
  });

  it('el input numérico abre el teclado decimal', () => {
    renderForm('sma');
    const input = screen.getByRole('textbox', { name: 'Periodo' });
    expect(input.getAttribute('inputmode')).toBe('decimal');
  });

  it('deja escribir valores intermedios y limita al confirmar con blur', async () => {
    const user = userEvent.setup();
    const { onChange, last } = renderForm('sma', { params: { length: 20 } });
    const input = screen.getByRole('textbox', { name: 'Periodo' });
    await user.clear(input);
    await user.type(input, '1');
    // Mientras escribe no se fuerza el mínimo (2): podría estar tecleando 15.
    expect(input.value).toBe('1');
    expect(onChange.mock.calls.some(([ind]) => ind.params.length === 2)).toBe(false);
    fireEvent.blur(input);
    expect(last().params.length).toBe(2);
    expect(input.value).toBe('2');
  });

  it('propaga un valor válido mientras se escribe', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sma', { params: { length: 20 } });
    const input = screen.getByRole('textbox', { name: 'Periodo' });
    await user.clear(input);
    await user.type(input, '55');
    expect(last().params.length).toBe(55);
  });

  it('acepta coma decimal y confirma con Enter', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sqzmom');
    const input = screen.getByRole('textbox', { name: 'KC mult.' });
    await user.clear(input);
    await user.type(input, '1,77{Enter}');
    expect(last().params.multKC).toBe(1.8);
    expect(input.value).toBe('1.8');
  });

  it('las flechas del teclado suben y bajan un paso como el input nativo', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sma', { params: { length: 20 } });
    const input = screen.getByRole('textbox', { name: 'Periodo' });
    await user.click(input);
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowDown}');
    expect(last().params.length).toBe(21);
    expect(input.value).toBe('21');
  });

  it('restaura el valor anterior si el campo queda vacío', async () => {
    const user = userEvent.setup();
    renderForm('sma', { params: { length: 20 } });
    const input = screen.getByRole('textbox', { name: 'Periodo' });
    await user.clear(input);
    fireEvent.blur(input);
    expect(input.value).toBe('20');
  });

  it('los booleanos son interruptores accesibles que se alternan con un toque', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sqzmom');
    const sw = screen.getByRole('switch', { name: 'Usar True Range' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await user.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(last().params.useTrueRange).toBe(false);
  });

  it('muestra el hex junto al selector de color y lo actualiza', () => {
    const { last } = renderForm('sma');
    const hex = screen.getByRole('textbox', { name: 'Color (hex)' });
    expect(hex.value).toBe('#60a5fa');
    fireEvent.change(screen.getByLabelText('Color'), { target: { value: '#ff0000' } });
    expect(last().style.color).toBe('#ff0000');
    expect(hex.value).toBe('#ff0000');
  });

  it('el hex escrito admite forma corta y revierte si no es válido', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sma');
    const hex = screen.getByRole('textbox', { name: 'Color (hex)' });
    await user.clear(hex);
    await user.type(hex, '#abc{Enter}');
    expect(last().style.color).toBe('#aabbcc');
    await user.clear(hex);
    await user.type(hex, 'zz');
    fireEvent.blur(hex);
    expect(hex.value).toBe('#aabbcc');
  });

  it('el grosor y el tipo de línea se eligen con botones segmentados', async () => {
    const user = userEvent.setup();
    const { last } = renderForm('sma');
    const thick = screen.getByRole('button', { name: 'Grosor 3px' });
    await user.click(thick);
    expect(last().style.lineWidth).toBe(3);
    expect(thick.getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Punteada' }));
    expect(last().style.lineStyle).toBe('dotted');
  });
});

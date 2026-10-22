import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import MobileAlertEditor from './MobileAlertEditor';

const RSI = { indicatorType: 'rsi', indicatorParams: { length: 14 }, timeframe: '15m', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 } };
const MACD = { indicatorType: 'macd', indicatorParams: { fast: 12, slow: 26, signal: 9 }, timeframe: '1h', operandSeries: 'macd', operator: 'cross_up', operand: { kind: 'constant', value: 0 } };

const FORM = {
  name: 'RSI bajo',
  isActive: true,
  thresholdPercent: 70,
  cooldownSeconds: 900,
  telegramEnabled: true,
  datasource: 'binance',
  direction: 'bullish',
  assetList: ['BTCUSDT', 'ETHUSDT'],
  rules: [
    { id: 'a', label: 'sobreventa', weight: 2, conditions: [RSI], joiners: [] },
    { id: 'b', label: '', weight: 1, conditions: [RSI, MACD], joiners: ['or'] },
  ],
};

const DATASOURCES = [
  { value: 'binance', label: 'Binance (ej. BTCUSDT)', short: 'Binance' },
  { value: 'hyperliquid', label: 'Hyperliquid (ej. BTC)', short: 'Hyperliquid' },
];

function setup(overrides = {}) {
  const props = {
    form: FORM,
    selectedId: 1,
    isSaving: false,
    effectiveDirty: false,
    saveValidationError: null,
    updateField: vi.fn(),
    onBack: vi.fn(),
    onSave: vi.fn(),
    onRemove: vi.fn(),
    onTest: vi.fn().mockResolvedValue(null),
    onToggleActive: vi.fn(),
    isTogglingActive: false,
    editorMode: 'visual',
    rawText: '',
    rawError: '',
    onRawTextChange: vi.fn(),
    onOpenRaw: vi.fn(),
    onOpenVisual: vi.fn(),
    onRefreshRaw: vi.fn(),
    onApplyRaw: vi.fn(),
    onCopyConfig: vi.fn(),
    showPresets: false,
    presets: [],
    onApplyPreset: vi.fn(),
    datasources: DATASOURCES,
    telegramPreview: '🟢 ALCISTA · RSI bajo',
    showUsedBy: true,
    usedByBots: [{ id: 7, name: 'Momentum BTC', mode: 'shadow', structure: 'buy_with' }],
    directionNote: 'Nota de dirección',
    showNeutralWarning: false,
    assetInput: '',
    onAssetInput: vi.fn(),
    onAddAsset: vi.fn(),
    onRemoveAsset: vi.fn(),
    onOpenPicker: vi.fn(),
    onOpenRule: vi.fn(),
    onAddRule: vi.fn(),
    openRuleIndex: null,
    openRuleIsNew: false,
    onApplyRule: vi.fn(),
    onDiscardRule: vi.fn(),
    onDeleteRule: vi.fn(),
    ...overrides,
  };
  render(<MemoryRouter><MobileAlertEditor {...props} /></MemoryRouter>);
  return props;
}

describe('MobileAlertEditor', () => {
  it('cabecera con volver y el nombre de la alerta', () => {
    const p = setup();
    expect(screen.getByRole('heading', { name: 'Editar alerta' })).toBeTruthy();
    expect(screen.getAllByText('RSI bajo').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a alertas' }));
    expect(p.onBack).toHaveBeenCalled();
  });

  it('el umbral sube y baja de 5 en 5', () => {
    const p = setup();
    expect(screen.getByText('70 %')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Subir umbral' }));
    expect(p.updateField).toHaveBeenLastCalledWith('thresholdPercent', 75);
    fireEvent.click(screen.getByRole('button', { name: 'Bajar umbral' }));
    expect(p.updateField).toHaveBeenLastCalledWith('thresholdPercent', 65);
  });

  it('el umbral no sale de 0–100', () => {
    const p = setup({ form: { ...FORM, thresholdPercent: 98 } });
    fireEvent.click(screen.getByRole('button', { name: 'Subir umbral' }));
    expect(p.updateField).toHaveBeenLastCalledWith('thresholdPercent', 100);
    expect(screen.getByRole('button', { name: 'Subir umbral' }).disabled).toBe(false);
  });

  it('el umbral en los extremos deshabilita el botón', () => {
    setup({ form: { ...FORM, thresholdPercent: 100 } });
    expect(screen.getByRole('button', { name: 'Subir umbral' }).disabled).toBe(true);
  });

  it('el umbral en 0 no baja', () => {
    const p = setup({ form: { ...FORM, thresholdPercent: 3 } });
    fireEvent.click(screen.getByRole('button', { name: 'Bajar umbral' }));
    expect(p.updateField).toHaveBeenLastCalledWith('thresholdPercent', 0);
  });

  it('el cooldown es un selector de los presets', () => {
    const p = setup();
    const select = screen.getByLabelText('Cooldown');
    expect(select.value).toBe('900');
    fireEvent.change(select, { target: { value: '300' } });
    expect(p.updateField).toHaveBeenCalledWith('cooldownSeconds', 300);
  });

  it('la dirección es el radiogroup de siempre', () => {
    const p = setup();
    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    fireEvent.click(within(group).getByRole('radio', { name: /Bajista/ }));
    expect(p.updateField).toHaveBeenCalledWith('direction', 'bearish');
    expect(screen.getByText('Nota de dirección')).toBeTruthy();
  });

  it('en una alerta guardada, el interruptor Activa guarda al momento', () => {
    const p = setup();
    const sw = screen.getByRole('switch', { name: 'Activa' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(p.onToggleActive).toHaveBeenCalled();
    expect(p.updateField).not.toHaveBeenCalled();
  });

  it('en una alerta guardada con cambios, el interruptor queda deshabilitado', () => {
    setup({ effectiveDirty: true });
    expect(screen.getByRole('switch', { name: 'Activa' }).disabled).toBe(true);
  });

  it('en una alerta nueva, el interruptor Activa es un campo del formulario', () => {
    const p = setup({ selectedId: null, effectiveDirty: true });
    const sw = screen.getByRole('switch', { name: 'Activa' });
    expect(sw.disabled).toBe(false);
    fireEvent.click(sw);
    expect(p.updateField).toHaveBeenCalledWith('isActive', false);
    expect(p.onToggleActive).not.toHaveBeenCalled();
  });

  it('el símbolo se añade solo con Intro o con «Añadir», nunca al salir del campo', () => {
    const p = setup({ assetInput: 'SOLUSDT' });
    const input = screen.getByRole('textbox', { name: 'Símbolo' });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: ' ' });
    fireEvent.keyDown(input, { key: ',' });
    expect(p.onAddAsset).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onAddAsset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }));
    expect(p.onAddAsset).toHaveBeenCalledTimes(2);
  });

  it('«Añadir» deshabilitado sin símbolo', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Añadir' }).disabled).toBe(true);
  });

  it('«Más opciones» despliega datasource, Telegram y la vista previa', () => {
    const p = setup();
    expect(screen.queryByLabelText('Datasource')).toBeNull();
    expect(screen.queryByTestId('telegram-preview')).toBeNull();
    const more = screen.getByRole('button', { name: /Más opciones · Binance · Telegram sí/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByLabelText('Datasource'), { target: { value: 'hyperliquid' } });
    expect(p.updateField).toHaveBeenCalledWith('datasource', 'hyperliquid');
    fireEvent.click(screen.getByRole('checkbox', { name: /Enviar a Telegram/ }));
    expect(p.updateField).toHaveBeenCalledWith('telegramEnabled', false);
    expect(screen.getByTestId('telegram-preview').textContent).toContain('RSI bajo');
    expect(screen.getByText('Usada por 1 bot')).toBeTruthy();
    expect(screen.getByText('Momentum BTC')).toBeTruthy();
  });

  it('el menú «⋯» ofrece Modo JSON, Copiar config y Eliminar', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copiar config' }));
    expect(p.onCopyConfig).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Modo JSON' }));
    expect(p.onOpenRaw).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar alerta' }));
    expect(p.onRemove).toHaveBeenCalled();
  });

  it('sin selectedId el menú no ofrece Eliminar', () => {
    setup({ selectedId: null });
    expect(screen.getByRole('heading', { name: 'Nueva alerta' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).queryByRole('button', { name: 'Eliminar alerta' })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Modo JSON' })).toBeTruthy();
  });

  it('en modo JSON el menú vuelve a Visual y se ve el editor raw', () => {
    const p = setup({ editorMode: 'raw', rawText: '{"name":"x"}', rawError: 'JSON inválido' });
    const ta = screen.getByRole('textbox', { name: 'Configuración JSON' });
    expect(ta.value).toBe('{"name":"x"}');
    fireEvent.change(ta, { target: { value: '{}' } });
    expect(p.onRawTextChange).toHaveBeenCalledWith('{}');
    expect(screen.getByText('JSON inválido')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Subir umbral' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar al formulario' }));
    expect(p.onApplyRaw).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Modo visual' }));
    expect(p.onOpenVisual).toHaveBeenCalled();
  });

  it('activos: chips con quitar y «+ Añadir» abre el selector', () => {
    const p = setup();
    expect(screen.getByRole('heading', { name: 'Activos (2)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar ETHUSDT' }));
    expect(p.onRemoveAsset).toHaveBeenCalledWith('ETHUSDT');
    fireEvent.click(screen.getByRole('button', { name: '+ Añadir' }));
    expect(p.onOpenPicker).toHaveBeenCalled();
  });

  it('cada regla es una tarjeta con resumen y peso, y abre su editor', () => {
    const p = setup();
    expect(screen.getByRole('heading', { name: 'Reglas (2)' })).toBeTruthy();
    expect(screen.getByText('dispara con ≥ 70 % del peso')).toBeTruthy();
    const first = screen.getByRole('button', { name: /Regla 1/ });
    expect(first.textContent).toContain('RSI');
    expect(first.textContent).toContain('«sobreventa» · peso 2');
    const second = screen.getByRole('button', { name: /Regla 2/ });
    expect(second.textContent).toMatch(/ O /);
    expect(second.textContent).toContain('peso 1');
    fireEvent.click(second);
    expect(p.onOpenRule).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: '+ Añadir regla' }));
    expect(p.onAddRule).toHaveBeenCalled();
  });

  it('con una regla abierta muestra su hoja y la conecta con la página', () => {
    const p = setup({ openRuleIndex: 1 });
    const sheet = screen.getByRole('dialog', { name: 'Regla 2' });
    // Con dos reglas se puede eliminar.
    expect(within(sheet).getByRole('button', { name: 'Eliminar regla' }).disabled).toBe(false);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Aplicar regla' }));
    expect(p.onApplyRule).toHaveBeenCalledWith(1, expect.objectContaining({ conditions: expect.any(Array) }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Eliminar regla' }));
    expect(p.onDeleteRule).toHaveBeenCalledWith(1);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Descartar cambios' }));
    expect(p.onDiscardRule).toHaveBeenCalled();
  });

  it('con effectiveDirty se ve «Cambios sin guardar»', () => {
    setup({ effectiveDirty: true });
    expect(screen.getByText(/Cambios sin guardar/)).toBeTruthy();
  });

  it('sin cambios no se ve el aviso', () => {
    setup();
    expect(screen.queryByText(/Cambios sin guardar/)).toBeNull();
  });

  it('«Guardar cambios» queda deshabilitado con un error de validación', () => {
    setup({ effectiveDirty: true, saveValidationError: 'Falta el nombre de la alerta' });
    expect(screen.getByRole('button', { name: 'Guardar cambios' }).disabled).toBe(true);
    expect(screen.getByText('Falta el nombre de la alerta')).toBeTruthy();
  });

  it('«Guardar cambios» guarda con cambios válidos', () => {
    const p = setup({ effectiveDirty: true });
    const btn = screen.getByRole('button', { name: 'Guardar cambios' });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(p.onSave).toHaveBeenCalled();
  });

  it('«Probar» abre el resultado en una hoja', async () => {
    const data = { results: [{ asset: 'BTCUSDT', lowestTimeframe: '15m', score: 55, threshold: 70, wouldTrigger: false, rules: [] }] };
    const p = setup({ onTest: vi.fn().mockResolvedValue(data) });
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    expect(p.onTest).toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/55\.0% \/ 70%/)).toBeTruthy();
  });

  it('«Probar» deshabilitado con cambios sin guardar', () => {
    setup({ effectiveDirty: true });
    expect(screen.getByRole('button', { name: 'Probar' }).disabled).toBe(true);
  });

  it('muestra las plantillas en una alerta nueva sin tocar', async () => {
    const preset = { id: 'p1', icon: '📉', title: 'RSI sobreventa', description: 'desc', direction: 'bullish' };
    const p = setup({ selectedId: null, showPresets: true, presets: [preset] });
    fireEvent.click(screen.getByRole('button', { name: /RSI sobreventa/ }));
    await waitFor(() => expect(p.onApplyPreset).toHaveBeenCalledWith(preset));
  });
});

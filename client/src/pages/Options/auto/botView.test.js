import { describe, expect, it } from 'vitest';
import {
  botDirections, buildBotKpis, buildBotPayload, normalizeAlert, buildMapping, filterSignals, initialBotForm,
  describeParams, perSignalBudget, statusLabel, latestSignal, normalizeBot, normalizeSignals, signalStats, takeProfitModesFor, validateBotForm, withStructure, withTakeProfitMode,
} from './botView';

describe('buildMapping', () => {
  it('comprar a favor: alcista → call, bajista → put', () => {
    const rows = buildMapping('buy_with', { targetDelta: 0.35, expiryDays: 7 });
    expect(rows.map((r) => [r.direction, r.action, r.detail])).toEqual([
      ['bullish', 'Comprar call', 'Δ ≈ 0,35 · venc. ~7 d'],
      ['bearish', 'Comprar put', 'Δ ≈ −0,35 · venc. ~7 d'],
    ]);
  });

  it('vender en contra: alcista → vende put, bajista → vende call', () => {
    const rows = buildMapping('sell_against', { targetDelta: 0.25, expiryDays: 14 });
    expect(rows.map((r) => [r.direction, r.action, r.detail])).toEqual([
      ['bullish', 'Vender put', 'Δ ≈ −0,25 · venc. ~14 d'],
      ['bearish', 'Vender call', 'Δ ≈ 0,25 · venc. ~14 d'],
    ]);
  });
});

describe('configuración completa del bot', () => {
  const base = { id: 1, underlying: 'ETH', params: { structure: 'buy_with', takeProfitMode: 'fixed' } };
  const row = (rows, key) => rows.find((r) => r.key === key);

  it('volatilidad: la fila de TP no usa «%»', () => {
    const d = describeParams(normalizeBot({ ...base, params: { ...base.params, takeProfitMode: 'volatility', tpAtrMultiplier: 1.5, tpHorizonHours: 6 } }));
    const tp = row(d.exits, 'takeProfitPct');
    expect(tp.value).toBe('ATR × 1,5 + IV · horizonte 6 h');
    expect(tp.value).not.toContain('%');
  });

  it('entrada: contratos, capital y prima máx.', () => {
    const d = describeParams(normalizeBot({ ...base, params: { ...base.params, contractCount: 3, capitalUsdt: null, maxPremiumUsdt: 150 } }));
    expect(row(d.entry, 'contractCount').value).toBe('3');
    expect(row(d.entry, 'capitalUsdt').value).toBe('sin límite');
    expect(row(d.entry, 'maxPremiumUsdt').value).toContain('150');
    const c = describeParams(normalizeBot({ ...base, params: { ...base.params, capitalUsdt: 500 } }));
    expect(row(c.entry, 'capitalUsdt').value).toContain('500');
  });

  it('vender en contra no muestra «Prima máx.» en la entrada', () => {
    const d = describeParams(normalizeBot({ ...base, params: { structure: 'sell_against' } }));
    expect(row(d.entry, 'maxPremiumUsdt')).toBeUndefined();
  });

  it('atr_band no repite «Señal contraria»', () => {
    const d = describeParams(normalizeBot({ ...base, params: { ...base.params, takeProfitMode: 'atr_band' } }));
    expect(row(d.entry, 'onOpposite')).toBeUndefined();
  });

  it('ventana de vencimiento de la alerta en el mapeo', () => {
    const alerts = [
      { id: 1, direction: 'bullish', optionExpiryMinDays: 7, optionExpiryMaxDays: 14 },
      { id: 2, direction: 'bearish' },
    ].map(normalizeAlert);
    const rows = buildMapping('buy_with', { targetDelta: 0.35, expiryDays: 7, alerts });
    expect(rows[0].detail).toBe('Δ ≈ 0,35 · venc. 7–14 d (de la alerta)');
    expect(rows[1].detail).toBe('Δ ≈ −0,35 · venc. ~7 d');
  });

  it('estado del runner en lenguaje humano', () => {
    expect(statusLabel('paused')).toBe('Pausado');
    expect(statusLabel('in_position')).toBe('En posición');
    expect(statusLabel('waiting')).toBe('Esperando señal');
    expect(statusLabel('algo_nuevo_raro')).toBe('Sin estado');
    expect(statusLabel('')).toBe('—');
    expect(normalizeBot({ id: 1, status: 'paused' }).statusLabel).toBe('Pausado');
  });
});

describe('formulario de bot', () => {
  it('valores por defecto según la estructura', () => {
    const f = initialBotForm({ underlying: 'ETH' });
    expect(f).toMatchObject({ underlying: 'ETH', structure: 'buy_with', targetDelta: 0.35, takeProfitPct: 80, stopLossPct: 50, maxPremiumUsdt: 150, expiryDays: 7, onOpposite: 'reverse', exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4 });
    const s = withStructure(f, 'sell_against');
    expect(s).toMatchObject({ structure: 'sell_against', targetDelta: 0.25, takeProfitPct: 50, stopLossPct: 200, maxPremiumUsdt: null, maxMarginUsdt: 1000 });
  });

  it('valida nombre, alertas y rangos', () => {
    const errors = validateBotForm({ ...initialBotForm(), name: ' ', alertIds: [], targetDelta: 2, maxOpenPositions: 1.5 });
    expect(errors).toEqual({
      name: 'Ponle un nombre',
      alertIds: 'Elige al menos una alerta',
      targetDelta: 'Máximo 0,95',
      maxOpenPositions: 'Debe ser un número entero',
    });
  });

  it('payload: prima máx. sólo al comprar; margen en limits al vender; sin subyacente al editar', () => {
    const buy = buildBotPayload({ ...initialBotForm({ underlying: 'BTC' }), takeProfitMode: 'fixed', name: ' Bot ', alertIds: [3] });
    expect(buy).toEqual({
      name: 'Bot',
      underlying: 'BTC',
      alertIds: [3],
      params: {
        structure: 'buy_with', targetDelta: 0.35, expiryDays: 7, quantity: 0.01, onOpposite: 'reverse',
        takeProfitPct: 80, stopLossPct: 50, exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4,
        maxPremiumUsdt: 150, contractCount: 1, capitalUsdt: null, budgetUsdt: null, budgetFractions: 4,
        takeProfitMode: 'fixed', tpAtrMultiplier: 1, tpHorizonHours: 4,
        notify: { trades: true, errors: true },
      },
      limits: {},
    });
    const sell = buildBotPayload({ ...withStructure(initialBotForm(), 'sell_against'), name: 'S', alertIds: [1] }, { editing: true, baseLimits: { maxDailyLossUsdt: 50 } });
    expect(sell.underlying).toBeUndefined();
    expect(sell.params.maxPremiumUsdt).toBeUndefined();
    expect(sell.limits).toEqual({ maxDailyLossUsdt: 50, maxMarginUsdt: 1000 });
  });

  it('configura TP ATR/IV y valida parámetros de volatilidad', () => {
    const base = initialBotForm({ underlying: 'ETH' });
    expect(base.takeProfitMode).toBe('atr_band');
    const dynamic = { ...base, name: 'TP dinámico', alertIds: [3],
      takeProfitMode: 'volatility', tpAtrMultiplier: 1.5, tpHorizonHours: 6 };
    expect(validateBotForm(dynamic)).toEqual({});
    const payload = buildBotPayload(dynamic);
    expect(payload.params).toMatchObject({
      takeProfitMode: 'volatility', tpAtrMultiplier: 1.5, tpHorizonHours: 6,
    });
    expect(initialBotForm({ bot: normalizeBot({ id: 2, params: payload.params }) })).toMatchObject({
      takeProfitMode: 'volatility', tpAtrMultiplier: 1.5, tpHorizonHours: 6,
    });
    expect(validateBotForm({ ...dynamic, tpAtrMultiplier: 5, tpHorizonHours: 2.5 })).toMatchObject({
      tpAtrMultiplier: 'Máximo 4', tpHorizonHours: 'Debe ser un número entero',
    });
  });

  it('banda ATR: nuevo buy_with nace con atr_band; sell_against no la ofrece', () => {
    expect(initialBotForm({ underlying: 'ETH' })).toMatchObject({ takeProfitMode: 'atr_band', atrBandInterval: '1h', atrBandLength: 14, atrBandMultiplier: 2, tpMaxGainPct: 200 });
    expect(takeProfitModesFor('buy_with').map((m) => m.value)).toEqual(['atr_band', 'fixed', 'volatility']);
    expect(takeProfitModesFor('sell_against').map((m) => m.value)).toEqual(['fixed', 'volatility']);
    const sell = withStructure(initialBotForm(), 'sell_against');
    expect(sell).toMatchObject({ takeProfitMode: 'fixed', onOpposite: 'reverse', exitHoursBeforeExpiry: 12, stopLossPct: 200 });
    expect(validateBotForm({ ...sell, name: 'x', alertIds: [1], takeProfitMode: 'atr_band' }).takeProfitMode).toBeTruthy();
    expect(withStructure(sell, 'buy_with').takeProfitMode).toBe('atr_band');
    expect(withStructure(sell, 'buy_with', { editing: true }).takeProfitMode).toBe('fixed');
  });

  it('banda ATR: el payload lleva los cuatro params y no stopLossPct', () => {
    const form = { ...initialBotForm({ underlying: 'ETH' }), name: 'ATR', alertIds: [3], atrBandInterval: '4h', atrBandLength: 20, atrBandMultiplier: 1.5, tpMaxGainPct: 300 };
    expect(validateBotForm(form)).toEqual({});
    const { params } = buildBotPayload(form);
    expect(params).toMatchObject({ takeProfitMode: 'atr_band', atrBandInterval: '4h', atrBandLength: 20, atrBandMultiplier: 1.5, tpMaxGainPct: 300, onOpposite: 'ignore', exitHoursBeforeExpiry: 0 });
    expect('stopLossPct' in params).toBe(false);
    expect(validateBotForm({ ...form, atrBandLength: 1, atrBandMultiplier: 11, tpMaxGainPct: 5, atrBandInterval: '2h' })).toMatchObject({
      atrBandLength: 'Mínimo 2', atrBandMultiplier: 'Máximo 10', tpMaxGainPct: 'Mínimo 10', atrBandInterval: 'Elige una temporalidad',
    });
  });

  it('banda ATR: al salir se restauran onOpposite, salida por tiempo y stop', () => {
    const bot = normalizeBot({ id: 1, params: { structure: 'buy_with', takeProfitMode: 'atr_band', onOpposite: 'ignore', exitHoursBeforeExpiry: 0, atrBandInterval: '15m' } });
    const form = initialBotForm({ bot });
    expect(form).toMatchObject({ takeProfitMode: 'atr_band', atrBandInterval: '15m', onOpposite: 'ignore', exitHoursBeforeExpiry: 0 });
    expect(withTakeProfitMode(form, 'fixed')).toMatchObject({ takeProfitMode: 'fixed', onOpposite: 'reverse', exitHoursBeforeExpiry: 12, stopLossPct: 50 });
  });

  it('describeParams en atr_band', () => {
    const d = describeParams(normalizeBot({ id: 1, underlying: 'ETH', params: { structure: 'buy_with', takeProfitMode: 'atr_band', atrBandInterval: '1h', atrBandLength: 14, atrBandMultiplier: 2, tpMaxGainPct: 200 } }));
    expect(d.exits).toEqual([
      expect.objectContaining({ label: 'Venta por banda ATR', value: '1h 14/2 · tope +200 %' }),
      expect.objectContaining({ label: 'Sin stop', value: 'se mantiene hasta vencer' }),
    ]);
  });

  it('al editar parte de los parámetros guardados', () => {
    const bot = normalizeBot({
      id: 1, name: 'X', underlying: 'SOL', mode: 'live',
      params: { alertIds: [4, 5], structure: 'sell_against', targetDelta: -0.3, quantity: 2, onOpposite: 'close' },
      limits: { maxMarginUsdt: 500 },
    });
    expect(initialBotForm({ bot })).toMatchObject({
      name: 'X', underlying: 'SOL', alertIds: [4, 5], structure: 'sell_against', targetDelta: 0.3, quantity: 2, onOpposite: 'close', takeProfitPct: 50, maxMarginUsdt: 500,
    });
  });
});

describe('señales y KPIs', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  const raw = [
    { id: 1, alertName: 'A', direction: 'bullish', score: 85, decision: 'opened', createdAt: now - 1000 },
    { id: 2, alertName: 'B', direction: 'bearish', score: 72, decision: 'ignored', detail: 'Máx. 1', createdAt: now - 5000 },
    { id: 3, alertName: 'B', direction: 'bearish', score: 70, decision: 'closed', createdAt: now - 3000 },
    { id: 4, alertName: 'B', direction: 'bearish', score: 70, decision: 'error', createdAt: now - 40 * 86400000 },
  ];

  it('ordena por fecha y filtra operadas / ignoradas', () => {
    const list = normalizeSignals(raw);
    expect(list.map((s) => s.id)).toEqual([1, 3, 2, 4]);
    expect(filterSignals(list, 'traded').map((s) => s.decisionLabel)).toEqual(['Abrió', 'Cerró']);
    expect(filterSignals(list, 'ignored').map((s) => s.decisionLabel)).toEqual(['Ignorada']);
    expect(filterSignals(list, 'all').find((s) => s.decision === 'error')?.decisionLabel).toBe('Error');
  });

  it('KPIs: señales de 30 días por dirección, operadas, P&L por libro y acierto', () => {
    const stats = signalStats(normalizeSignals(raw), now);
    expect(stats).toEqual({ total: 3, bullish: 1, bearish: 2, traded: 2 });
    const kpis = buildBotKpis({ mode: 'shadow', kpis: { shadow: { pnl30dUsdt: 214.6, cycles: 9, winRatePct: 66.67 }, live: { pnl30dUsdt: -5 } } }, stats);
    expect(kpis.map((k) => [k.label, k.value, k.hint])).toEqual([
      ['Señales 30d', '3', '1 alcistas · 2 bajistas'],
      ['Operadas', '2', 'el resto, ignoradas por reglas'],
      ['P&L sombra', '+214,60', 'USDT · 30 días'],
      ['P&L real', '−5,00', 'USDT · 30 días'],
      ['Acierto', '6 / 9', 'operaciones ganadoras'],
      ['P&L medio por operación', '—', 'USDT · operaciones cerradas'],
      ['Peor racha / drawdown', '—', 'caída máx. y pérdidas seguidas (USDT)'],
    ]);
  });

  it('las señales simuladas llevan la marca y no cuentan en los KPIs', () => {
    const list = normalizeSignals([
      ...raw,
      { id: 9, alertName: 'Simulación', direction: 'bullish', decision: 'opened', simulated: true, createdAt: now - 10 },
    ]);
    expect(list.find((s) => s.id === 9).simulated).toBe(true);
    expect(list.find((s) => s.id === 1).simulated).toBe(false);
    expect(signalStats(list, now)).toEqual({ total: 3, bullish: 1, bearish: 2, traded: 2 });
  });

  it('direcciones del bot y última señal entre bots', () => {
    expect(botDirections([{ direction: 'bearish' }, { direction: 'bullish' }, { direction: 'bullish' }])).toEqual(['bullish', 'bearish']);
    const bots = [
      normalizeBot({ id: 1, lastSignal: { direction: 'bearish', decision: 'ignored', createdAt: 10 } }),
      normalizeBot({ id: 2, lastSignal: { direction: 'bullish', decision: 'opened', createdAt: 20 } }),
      normalizeBot({ id: 3 }),
    ];
    expect(latestSignal(bots).bot.id).toBe(2);
  });
});

describe('KPIs de operaciones cerradas (del servidor)', () => {
  const book = (o) => ({ cycles: 3, winRatePct: 66.67, ...o });
  const byKey = (bot) => Object.fromEntries(buildBotKpis(bot, null).map((k) => [k.key, k]));

  it('con menos de 5 operaciones cerradas el acierto es «n/a (3 ops)»', () => {
    const k = byKey({ mode: 'shadow', kpis: { shadow: book({ closedTrades: 3, avgPnlUsdt: 3 }) } });
    expect(k.wins.value).toBe('n/a (3 ops)');
    expect(k.avgPnl.value).toBe('+3,00');
  });

  it('con 5 o más muestra aciertos, media, drawdown y racha del libro activo', () => {
    const shadow = book({ cycles: 6, winRatePct: 33.33, closedTrades: 6, avgPnlUsdt: 0.33, maxDrawdownUsdt: 13, longestLosingStreak: 3 });
    const k = byKey({ mode: 'shadow', kpis: { shadow, live: book({ closedTrades: 1, avgPnlUsdt: 99 }) } });
    expect(k.wins.value).toBe('2 / 6');
    expect(k.drawdown.value).toBe('−13,00 · 3 seguidas');
    expect(k.avgPnl.value).toBe('+0,33');
  });

  it('usa el libro real si el bot está en Real', () => {
    const k = byKey({ mode: 'live', kpis: {
      shadow: book({ closedTrades: 50, avgPnlUsdt: 9 }),
      live: book({ cycles: 5, winRatePct: 80, closedTrades: 5, avgPnlUsdt: 1.6, maxDrawdownUsdt: 4, longestLosingStreak: 1 }),
    } });
    expect(k.wins.value).toBe('4 / 5');
    expect(k.drawdown.value).toBe('−4,00 · 1 seguida');
  });

  it('sin operaciones cerradas: «—»', () => {
    const k = byKey({ mode: 'shadow', kpis: { shadow: book({ cycles: 0, winRatePct: null, closedTrades: 0, avgPnlUsdt: null, maxDrawdownUsdt: null, longestLosingStreak: 0 }) } });
    expect(k.avgPnl.value).toBe('—');
    expect(k.drawdown.value).toBe('—');
    expect(k.wins.value).toBe('n/a (0 ops)');
  });

  it('notify: el formulario lo lee (activo si falta) y el payload lo envía', () => {
    const form = initialBotForm({ bot: normalizeBot({ id: 1, underlying: 'BTC', params: { alertIds: [1], notify: { trades: false, errors: true } } }) });
    expect(form.notifyTrades).toBe(false);
    expect(form.notifyErrors).toBe(true);
    expect(initialBotForm({ bot: normalizeBot({ id: 1, params: { alertIds: [1] } }) }).notifyTrades).toBe(true);
    expect(buildBotPayload({ ...form, alertIds: [1], name: 'x' }).params.notify).toEqual({ trades: false, errors: true });
  });
});

describe('presupuesto total en fracciones', () => {
  const form = (extra = {}) => ({ ...initialBotForm({ underlying: 'BTC' }), name: 'B', alertIds: [1], ...extra });
  const row = (rows, key) => rows.find((r) => r.key === key);

  it('por defecto: sin presupuesto y 4 fracciones', () => {
    expect(initialBotForm()).toMatchObject({ budgetUsdt: null, budgetFractions: 4 });
    expect(perSignalBudget(form())).toBeNull();
  });

  it('hasta presupuesto / fracciones por señal', () => {
    expect(perSignalBudget(form({ budgetUsdt: 48, budgetFractions: 4 }))).toBe(12);
    expect(perSignalBudget(form({ budgetUsdt: 48, budgetFractions: 0 }))).toBeNull();
  });

  it('valida presupuesto > 0 y fracciones enteras 1–20 solo si hay presupuesto', () => {
    expect(validateBotForm(form({ budgetUsdt: 48, budgetFractions: 4 }))).toEqual({});
    expect(validateBotForm(form({ budgetUsdt: 0 })).budgetUsdt).toBeTruthy();
    expect(validateBotForm(form({ budgetUsdt: 48, budgetFractions: 21 })).budgetFractions).toBe('Máximo 20');
    expect(validateBotForm(form({ budgetUsdt: 48, budgetFractions: 2.5 })).budgetFractions).toBe('Debe ser un número entero');
    expect(validateBotForm(form({ budgetUsdt: null, budgetFractions: 99 })).budgetFractions).toBeUndefined();
  });

  it('payload: con presupuesto se envía y capitalUsdt queda en null', () => {
    const p = buildBotPayload(form({ budgetUsdt: 48, budgetFractions: 6, capitalUsdt: 500 })).params;
    expect(p).toMatchObject({ budgetUsdt: 48, budgetFractions: 6, capitalUsdt: null });
    const q = buildBotPayload(form({ capitalUsdt: 500 })).params;
    expect(q).toMatchObject({ budgetUsdt: null, budgetFractions: 4, capitalUsdt: 500 });
  });

  it('editar recupera presupuesto y fracciones; los bots antiguos sin claves quedan sin presupuesto', () => {
    expect(initialBotForm({ bot: normalizeBot({ id: 1, params: { budgetUsdt: 48, budgetFractions: 6 } }) })).toMatchObject({ budgetUsdt: 48, budgetFractions: 6 });
    expect(initialBotForm({ bot: normalizeBot({ id: 1, params: {} }) })).toMatchObject({ budgetUsdt: null, budgetFractions: 4 });
  });

  it('describeParams: presupuesto sustituye al capital por entrada', () => {
    const d = describeParams(normalizeBot({ id: 1, underlying: 'BTC', params: { structure: 'buy_with', budgetUsdt: 48, budgetFractions: 4, capitalUsdt: 500 } }));
    expect(row(d.entry, 'capitalUsdt')).toBeUndefined();
    expect(row(d.entry, 'budgetUsdt').value).toBe('48 USDT · 4 fracciones · hasta 12 USDT por señal');
    const old = describeParams(normalizeBot({ id: 1, underlying: 'BTC', params: { structure: 'buy_with' } }));
    expect(row(old.entry, 'budgetUsdt')).toBeUndefined();
    expect(row(old.entry, 'capitalUsdt')).toBeTruthy();
  });
});

describe('filtros de entrada: spread y apalancamiento', () => {
  const form = (extra = {}) => ({ ...initialBotForm({ underlying: 'BTC' }), name: 'B', alertIds: [1], ...extra });
  const row = (rows, key) => rows.find((r) => r.key === key);

  it('apagados por defecto: no se envían ni se muestran', () => {
    expect(initialBotForm()).toMatchObject({ maxSpreadPct: null, minLeverage: null });
    const p = buildBotPayload(form()).params;
    expect(p.maxSpreadPct).toBeUndefined();
    expect(p.minLeverage).toBeUndefined();
    const d = describeParams(normalizeBot({ id: 1, underlying: 'BTC', params: { structure: 'buy_with' } }));
    expect(row(d.entry, 'maxSpreadPct')).toBeUndefined();
    expect(row(d.entry, 'minLeverage')).toBeUndefined();
  });

  it('payload, validación y detalle cuando están activos', () => {
    const p = buildBotPayload(form({ maxSpreadPct: 8, minLeverage: 5 })).params;
    expect(p).toMatchObject({ maxSpreadPct: 8, minLeverage: 5 });
    const s = buildBotPayload({ ...form({ maxSpreadPct: 8, minLeverage: 5 }), structure: 'sell_against' }).params;
    expect(s.maxSpreadPct).toBe(8);
    expect(s.minLeverage).toBeUndefined();
    expect(validateBotForm(form({ maxSpreadPct: 0 })).maxSpreadPct).toBeTruthy();
    expect(validateBotForm(form({ minLeverage: -1 })).minLeverage).toBeTruthy();
    expect(validateBotForm(form({ maxSpreadPct: 8, minLeverage: 5 }))).toEqual({});
    const bot = normalizeBot({ id: 1, underlying: 'BTC', params: { structure: 'buy_with', maxSpreadPct: 8, minLeverage: 5 } });
    expect(initialBotForm({ bot })).toMatchObject({ maxSpreadPct: 8, minLeverage: 5 });
    const d = describeParams(bot);
    expect(row(d.entry, 'maxSpreadPct').value).toBe('8 %');
    expect(row(d.entry, 'minLeverage').value).toBe('5×');
  });
});

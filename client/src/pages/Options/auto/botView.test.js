import { describe, expect, it } from 'vitest';
import {
  botDirections, buildBotKpis, buildBotPayload, normalizeAlert, buildMapping, filterSignals, initialBotForm,
  describeParams, coveredList, botStatus, flowSteps, feeSummary, ladder, signalFeeText, formatCountdown, perSignalBudget, statusLabel, latestSignal, normalizeBot, normalizeSignals, signalStats, takeProfitModesFor, validateBotForm, withStructure, withTakeProfitMode,
} from './botView';

describe('buildMapping', () => {
  it('delta ≥ 0,9: dice «más cercana al precio» en vez del delta (ninguna OTM llega)', () => {
    const rows = buildMapping('buy_with', { targetDelta: 0.95, expiryDays: 2 });
    expect(rows.map((r) => r.detail)).toEqual(['Más cercana al precio · venc. ~2 d', 'Más cercana al precio · venc. ~2 d']);
  });
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

  it('entrada: capital y prima máx.; sin fila de contratos (siempre 1)', () => {
    const d = describeParams(normalizeBot({ ...base, params: { ...base.params, contractCount: 3, capitalUsdt: null, maxPremiumUsdt: 150 } }));
    expect(row(d.entry, 'contractCount')).toBeUndefined();
    expect(row(d.entry, 'capitalUsdt').value).toBe('sin límite');
    expect(row(d.entry, 'maxPremiumUsdt').value).toContain('150');
    const c = describeParams(normalizeBot({ ...base, params: { ...base.params, capitalUsdt: 500 } }));
    expect(row(c.entry, 'capitalUsdt').value).toContain('500');
  });

  it('vender en contra no muestra «Prima máx.» en la entrada', () => {
    const d = describeParams(normalizeBot({ ...base, params: { structure: 'sell_against' } }));
    expect(row(d.entry, 'maxPremiumUsdt')).toBeUndefined();
  });

  it('atr_band también muestra «Señal contraria»', () => {
    const d = describeParams(normalizeBot({ ...base, params: { ...base.params, takeProfitMode: 'atr_band', onOpposite: 'close' } }));
    expect(row(d.entry, 'onOpposite').value).toBe('Cierra la posición y no abre otra');
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
    expect(f).toMatchObject({ underlyings: ['ETH'], structure: 'buy_with', targetDelta: 0.35, takeProfitPct: 80, stopLossPct: 50, maxPremiumUsdt: 150, expiryDays: 7, onOpposite: 'reverse', exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4 });
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
      underlyings: ['BTC'],
      alertIds: [3],
      params: {
        structure: 'buy_with', targetDelta: 0.35, expiryDays: 7, expiryMinDays: null, expiryMaxDays: null, quantity: 0.01, onOpposite: 'reverse',
        takeProfitPct: 80, stopLossPct: 50, exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4,
        maxPremiumUsdt: 150, contractCount: 1, capitalUsdt: null, budgetUsdt: null, budgetFractions: 4,
        maxSpreadPct: null, minLeverage: null,
        takeProfitMode: 'fixed', tpAtrMultiplier: 1, tpHorizonHours: 4,
        notify: { trades: true, errors: true },
      },
      limits: {},
    });
    const sell = buildBotPayload({ ...withStructure(initialBotForm(), 'sell_against'), name: 'S', alertIds: [1] }, { editing: true, baseLimits: { maxDailyLossUsdt: 50 } });
    expect(sell.underlying).toBeUndefined();
    expect(sell.underlyings).toEqual(['BTC']);
    expect(sell.params.maxPremiumUsdt).toBeNull();
    expect(sell.params.minLeverage).toBeNull();
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

  it('rango de vencimiento opcional del bot: ambos o ninguno, mínimo ≤ máximo', () => {
    const base = { ...initialBotForm({ underlying: 'ETH' }), name: 'R', alertIds: [3] };
    expect(base).toMatchObject({ expiryMinDays: null, expiryMaxDays: null });
    expect(validateBotForm(base)).toEqual({});
    const ranged = { ...base, expiryMinDays: 7, expiryMaxDays: 14 };
    expect(validateBotForm(ranged)).toEqual({});
    expect(buildBotPayload(ranged).params).toMatchObject({ expiryMinDays: 7, expiryMaxDays: 14 });
    expect(initialBotForm({ bot: normalizeBot({ id: 2, params: { expiryMinDays: 7, expiryMaxDays: 14 } }) }))
      .toMatchObject({ expiryMinDays: 7, expiryMaxDays: 14 });
    expect(validateBotForm({ ...base, expiryMinDays: 7 })).toEqual({ expiryMaxDays: 'Indica también el máximo' });
    expect(validateBotForm({ ...base, expiryMaxDays: 7 })).toEqual({ expiryMinDays: 'Indica también el mínimo' });
    expect(validateBotForm({ ...base, expiryMinDays: 20, expiryMaxDays: 10 })).toEqual({ expiryMaxDays: 'Debe ser ≥ al mínimo' });
    expect(validateBotForm({ ...base, expiryMinDays: 1, expiryMaxDays: 200 })).toEqual({ expiryMaxDays: 'Máximo 180' });
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
    const form = { ...initialBotForm({ underlying: 'ETH' }), name: 'ATR', alertIds: [3], atrBandInterval: '4h', atrBandLength: 20, atrBandMultiplier: 1.5, tpMaxGainPct: 300, onOpposite: 'close' };
    expect(validateBotForm(form)).toEqual({});
    const { params } = buildBotPayload(form);
    expect(params).toMatchObject({ takeProfitMode: 'atr_band', atrBandInterval: '4h', atrBandLength: 20, atrBandMultiplier: 1.5, tpMaxGainPct: 300, onOpposite: 'close', exitHoursBeforeExpiry: 0 });
    expect('stopLossPct' in params).toBe(false);
    expect(validateBotForm({ ...form, atrBandLength: 1, atrBandMultiplier: 11, tpMaxGainPct: 5, atrBandInterval: '2h' })).toMatchObject({
      atrBandLength: 'Mínimo 2', atrBandMultiplier: 'Máximo 10', tpMaxGainPct: 'Mínimo 10', atrBandInterval: 'Elige una temporalidad',
    });
  });

  it('banda ATR: al salir se restauran salida por tiempo y stop; la señal contraria se conserva', () => {
    const bot = normalizeBot({ id: 1, params: { structure: 'buy_with', takeProfitMode: 'atr_band', onOpposite: 'ignore', exitHoursBeforeExpiry: 0, atrBandInterval: '15m' } });
    const form = initialBotForm({ bot });
    expect(form).toMatchObject({ takeProfitMode: 'atr_band', atrBandInterval: '15m', onOpposite: 'ignore', exitHoursBeforeExpiry: 0 });
    expect(withTakeProfitMode(form, 'fixed')).toMatchObject({ takeProfitMode: 'fixed', onOpposite: 'ignore', exitHoursBeforeExpiry: 12, stopLossPct: 50 });
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
      name: 'X', underlyings: ['SOL'], alertIds: [4, 5], structure: 'sell_against', targetDelta: 0.3, quantity: 2, onOpposite: 'close', takeProfitPct: 50, maxMarginUsdt: 500,
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

  it('subyacente que disparó la señal, a partir del activo', () => {
    const u = (asset) => normalizeSignals([{ id: 1, asset }])[0].underlying;
    expect(u('BTCUSDT')).toBe('BTC');
    expect(u('ethusdc')).toBe('ETH');
    expect(u('SOL-PERP')).toBe('SOL');
    expect(u('BNB')).toBe('BNB');
    expect(u(null)).toBe('');
  });

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

  it('las señales simuladas no cuentan como «Última señal» ni como «Operadas» (sí en «Todas»)', () => {
    const bots = [
      normalizeBot({ id: 1, lastSignal: { direction: 'bearish', decision: 'opened', createdAt: 10 } }),
      normalizeBot({ id: 2, lastSignal: { direction: 'bullish', decision: 'opened', simulated: true, createdAt: 20 } }),
    ];
    expect(latestSignal(bots).bot.id).toBe(1);
    expect(latestSignal([bots[1]])).toBeNull();
    const list = normalizeSignals([
      { id: 1, decision: 'opened', createdAt: 10 },
      { id: 2, decision: 'closed', simulated: true, createdAt: 20 },
    ]);
    expect(filterSignals(list, 'traded').map((s) => s.id)).toEqual([1]);
    expect(filterSignals(list, 'all').map((s) => [s.id, s.simulated])).toEqual([[2, true], [1, false]]);
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

  it('presupuesto vacío: fracciones ocultas fuera de rango no viajan (evita 400 invisible)', () => {
    const p = buildBotPayload(form({ budgetUsdt: '', budgetFractions: 99 })).params;
    expect(p).toMatchObject({ budgetUsdt: null, budgetFractions: 4 });
    expect(buildBotPayload(form({ budgetUsdt: null, budgetFractions: 2.5 })).params.budgetFractions).toBe(4);
  });

  it('editar y vaciar el presupuesto envía budgetUsdt: null', () => {
    const bot = normalizeBot({ id: 1, underlying: 'BTC', params: { structure: 'buy_with', budgetUsdt: 48, budgetFractions: 6 } });
    const edited = { ...initialBotForm({ bot }), name: 'B', alertIds: [1], budgetUsdt: '' };
    expect(buildBotPayload(edited, { editing: true }).params).toMatchObject({ budgetUsdt: null, budgetFractions: 4 });
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

  it('apagados por defecto: viajan como null y no se muestran', () => {
    expect(initialBotForm()).toMatchObject({ maxSpreadPct: null, minLeverage: null });
    const p = buildBotPayload(form()).params;
    // Se envían como null: el servidor fusiona params y un valor omitido persistiría.
    expect(p.maxSpreadPct).toBeNull();
    expect(p.minLeverage).toBeNull();
    const d = describeParams(normalizeBot({ id: 1, underlying: 'BTC', params: { structure: 'buy_with' } }));
    expect(row(d.entry, 'maxSpreadPct')).toBeUndefined();
    expect(row(d.entry, 'minLeverage')).toBeUndefined();
  });

  it('editar un bot con filtros y vaciarlos envía null (no persisten)', () => {
    const bot = normalizeBot({ id: 1, underlying: 'BTC', params: { structure: 'buy_with', maxSpreadPct: 8, minLeverage: 5, maxPremiumUsdt: 150 } });
    const edited = { ...initialBotForm({ bot }), name: 'B', alertIds: [1], maxSpreadPct: '', minLeverage: '', maxPremiumUsdt: '' };
    const p = buildBotPayload(edited, { editing: true }).params;
    expect(p).toHaveProperty('maxSpreadPct', null);
    expect(p).toHaveProperty('minLeverage', null);
    expect(p).toHaveProperty('maxPremiumUsdt', null);
  });

  it('payload, validación y detalle cuando están activos', () => {
    const p = buildBotPayload(form({ maxSpreadPct: 8, minLeverage: 5 })).params;
    expect(p).toMatchObject({ maxSpreadPct: 8, minLeverage: 5 });
    const s = buildBotPayload({ ...form({ maxSpreadPct: 8, minLeverage: 5 }), structure: 'sell_against' }).params;
    expect(s.maxSpreadPct).toBe(8);
    expect(s.minLeverage).toBeNull();
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

describe('varios subyacentes', () => {
  it('payload: underlyings y underlying = el primero', () => {
    const p = buildBotPayload({ ...initialBotForm({ underlying: 'BTC' }), name: 'M', alertIds: [3], underlyings: ['ETH', 'BTC'] });
    expect(p.underlyings).toEqual(['ETH', 'BTC']);
    expect(p.underlying).toBe('ETH');
  });

  it('un bot antiguo (sin params.underlyings) se edita con su único subyacente', () => {
    expect(initialBotForm({ bot: { id: 1, underlying: 'SOL', params: {} } }).underlyings).toEqual(['SOL']);
    expect(initialBotForm({ bot: { id: 1, underlying: 'BTC', underlyings: ['BTC', 'ETH'], params: {} } }).underlyings).toEqual(['BTC', 'ETH']);
    expect(normalizeBot({ id: 1, underlying: 'BTC', params: { underlyings: ['BTC', 'XRP'] } }).underlyings).toEqual(['BTC', 'XRP']);
    expect(normalizeBot({ id: 1, underlying: 'BTC', params: {} }).underlyings).toEqual(['BTC']);
  });

  it('valida al menos un subyacente y que cada uno lo cubra una alerta marcada', () => {
    const base = { ...initialBotForm(), name: 'M', alertIds: [3] };
    expect(validateBotForm({ ...base, underlyings: [] }).underlyings).toBe('Elige un subyacente');
    const alerts = [normalizeAlert({ id: 3, name: 'A', direction: 'bullish', assetList: ['BTCUSDT'] })];
    expect(validateBotForm({ ...base, underlyings: ['BTC', 'ETH'] }, { alerts }).alertIds).toBe('Ninguna alerta marcada cubre ETH');
    const both = [normalizeAlert({ id: 3, name: 'A', direction: 'bullish', assetList: ['BTCUSDT', 'ETHUSDT'] })];
    expect(validateBotForm({ ...base, underlyings: ['BTC', 'ETH'] }, { alerts: both }).alertIds).toBeUndefined();
  });

  it('muestra qué subyacentes elegidos cubre cada alerta', () => {
    const a = normalizeAlert({ id: 3, name: 'A', direction: 'bullish', assetList: ['BTCUSDT', 'ETHUSDT'] });
    expect(coveredList(a, ['BTC', 'ETH', 'SOL'])).toEqual(['BTC', 'ETH']);
    expect(coveredList({ ...a, coveredUnderlyings: ['ETH'] }, ['BTC', 'ETH'])).toEqual(['ETH']);
  });
});

describe('botStatus', () => {
  const now = 1_800_000_000_000;
  const pendingDetail = { pendingEntries: [{ id: 1, symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.35, limitPrice: 712, deadlineAt: now + 372_000 }] };
  it('entrada pendiente a 6:12 → pending con progreso ≈ 0,62', () => {
    const s = botStatus({ mode: 'live' }, pendingDetail, now);
    expect(s.kind).toBe('pending');
    expect(s.remainingMs).toBe(372_000);
    expect(s.progress).toBeCloseTo(0.62);
    expect(s.title).toContain('0,35');
    expect(s.title).toContain('BTC-261031-70000-C');
    expect(formatCountdown(s.remainingMs)).toBe('6:12');
  });
  it('bloqueo gana a posición y entrada pendiente', () => {
    const detail = { ...pendingDetail, blockedUnderlyings: { BTC: { reason: 'x', at: 1 } }, positions: [{ closedAt: null }] };
    expect(botStatus({ mode: 'live' }, detail, now).kind).toBe('blocked');
    expect(botStatus({ mode: 'live', blocked: true }, null, now).kind).toBe('blocked');
  });
  it('posición abierta, espera y pausa', () => {
    expect(botStatus({ mode: 'live' }, { positions: [{ mode: 'live', closedAt: null }] }, now).kind).toBe('position');
    expect(botStatus({ mode: 'shadow' }, { positions: [{ closedAt: null }] }, now).kind).toBe('position');
    expect(botStatus({ mode: 'live', status: 'in_position' }, null, now).kind).toBe('position');
    expect(botStatus({ mode: 'live', status: 'waiting' }, null, now).kind).toBe('waiting');
    expect(botStatus({ mode: 'paused' }, null, now).kind).toBe('paused');
  });
  it('solo cuentan las posiciones abiertas del modo del bot (real → live; sombra/pausado → shadow)', () => {
    const shadowOnly = { positions: [{ mode: 'shadow', closedAt: null }] };
    const liveOnly = { positions: [{ mode: 'live', closedAt: null }] };
    expect(botStatus({ mode: 'live' }, shadowOnly, now).kind).toBe('waiting');
    expect(botStatus({ mode: 'shadow' }, liveOnly, now).kind).toBe('waiting');
    expect(botStatus({ mode: 'paused' }, shadowOnly, now).kind).toBe('position');
    expect(botStatus({ mode: 'paused' }, liveOnly, now).kind).toBe('paused');
    // El «in_position» de la lista no contradice un detalle sin posición en su modo.
    expect(botStatus({ mode: 'live', status: 'in_position' }, shadowOnly, now).kind).toBe('waiting');
    expect(botStatus({ mode: 'live', status: 'in_position' }, { positions: [] }, now).kind).toBe('waiting');
  });
  it('lista con pendingEntry {deadlineAt} y sin detalle', () => {
    const s = botStatus({ mode: 'shadow', pendingEntry: { deadlineAt: now + 600_000 } }, null, now);
    expect(s.kind).toBe('pending');
    expect(s.progress).toBe(1);
    expect(botStatus({ mode: 'shadow', pendingEntry: { deadlineAt: now - 5 } }, null, now).progress).toBe(0);
  });
  it('estado de entrada desconocido no afirma que no haya entrada', () => {
    const s = botStatus({ mode: 'live', pendingEntryUnknown: true }, null, now);
    expect(s.kind).toBe('waiting');
    expect(s.detail).toBe('Estado de la entrada desconocido');
  });
});

describe('flowSteps', () => {
  const bot = {
    structure: 'buy_with', alerts: [{ name: 'MACD cruce 15m', thresholdPercent: 70 }],
    params: { structure: 'buy_with', targetDelta: 0.35, expiryDays: 7, takeProfitPct: 80, stopLossPct: 50, exitHoursBeforeExpiry: 12 },
  };
  it('cuatro pasos como la maqueta', () => {
    const steps = flowSteps(bot);
    expect(steps.map((s) => s.key)).toEqual(['signal', 'contract', 'entry', 'exit']);
    expect(steps.map((s) => s.title)).toEqual(['Señal', 'Contrato', 'Entrada', 'Salida']);
    expect(steps[0].subtitle).toBe('MACD cruce 15m · umbral 70 %');
    expect(steps[1].value).toBe('Compra call / put');
    expect(steps[1].subtitle).toBe('Δ ≈ 0,35 · vence ~7 d');
    expect(steps[2].value).toBe('GTC al precio medio');
    expect(steps[2].subtitle).toBe('espera 10 min; si no, se cancela');
    expect(steps[3].value).toBe('TP +80 % · Stop −50 %');
    expect(steps[3].subtitle).toBe('o 12 h antes del vencimiento');
  });
  it('banda ATR: TP banda ATR (GTC)', () => {
    const steps = flowSteps({ ...bot, params: { ...bot.params, takeProfitMode: 'atr_band' } });
    expect(steps[3].value).toBe('TP banda ATR (GTC)');
  });
});

describe('feeSummary / signalFeeText', () => {
  it('porcentaje y desglose en orden', () => {
    const f = feeSummary({ feesUsdt: 31.85, premiumUsdt: 690, feeBreakdown: { entryUsdt: 18.2, exitUsdt: 11.05, exerciseUsdt: 2.6, unallocatedUsdt: 0 } });
    expect(f.total).toBe(31.85);
    expect(f.pct).toBeCloseTo(4.6, 1);
    expect(f.label).toBe('4,6 % de la prima operada');
    expect(f.parts.map((p) => [p.key, p.label, p.usdt])).toEqual([
      ['entry', 'entrada', 18.2], ['exit', 'salida', 11.05], ['exercise', 'ejercicio', 2.6],
    ]);
  });
  it('sin desglose histórico solo si > 0; prefiere feesPctOfPremium', () => {
    const f = feeSummary({ feesUsdt: 10, feesPctOfPremium: 2.5, feeBreakdown: { entryUsdt: 1, exitUsdt: 2, exerciseUsdt: 0, unallocatedUsdt: 7 } });
    expect(f.pct).toBe(2.5);
    expect(f.parts.at(-1)).toEqual({ key: 'unallocated', label: 'sin desglose (histórico)', usdt: 7 });
  });
  it('sin datos', () => {
    const f = feeSummary({});
    expect(f.pct).toBeNull();
    expect(f.parts).toEqual([]);
  });
  it('signalFeeText y normalizeSignal', () => {
    expect(signalFeeText({ feesUsdt: 7.14, feesEstimated: true })).toBe('Comisión est. 7,14 USDT');
    expect(signalFeeText({ feesUsdt: 4.08, feesEstimated: false })).toBe('Comisión 4,08 USDT');
    expect(signalFeeText({ feesUsdt: null })).toBeNull();
    const s = normalizeSignals([{ id: 1, decision: 'opened', feesUsdt: 4.08, feesEstimated: true }])[0];
    expect(s.feesUsdt).toBe(4.08);
    expect(s.feesEstimated).toBe(true);
    expect(normalizeSignals([{ id: 2, decision: 'opened' }])[0].feesUsdt).toBeNull();
  });
});

describe('ladder', () => {
  it('compra: límite entre bid y ask, ahorro frente al ask', () => {
    const l = ladder({ side: 'BUY', bid: 700, ask: 725, limitPrice: 712 });
    expect(l.bidPct).toBe(0);
    expect(l.askPct).toBe(100);
    expect(l.midPct).toBeCloseTo(48);
    expect(l.savingPerContract).toBe(13);
  });
  it('venta: ahorro frente al bid; datos incompletos → null', () => {
    expect(ladder({ side: 'SELL', bid: 700, ask: 725, limitPrice: 713 }).savingPerContract).toBe(13);
    expect(ladder({ side: 'BUY', bid: null, ask: 725, limitPrice: 712 })).toBeNull();
  });
});

describe('normalizeBot (campos de la lista)', () => {
  it('pnlSeries, comisiones y entrada pendiente', () => {
    const b = normalizeBot({ id: 1, mode: 'live', pnlSeries: [1, 2], feesUsdt: 5.43, pendingEntry: { deadlineAt: 5 }, blocked: true });
    expect(b.pnlSeries).toEqual([1, 2]);
    expect(b.feesUsdt).toBe(5.43);
    expect(b.pendingEntry.deadlineAt).toBe(5000);
    expect(b.blocked).toBe(true);
    expect(b.pendingEntryUnknown).toBe(false);
    expect(normalizeBot({ id: 2 }).pnlSeries).toEqual([]);
    expect(normalizeBot({ id: 2 }).pendingEntry).toBeNull();
  });
});

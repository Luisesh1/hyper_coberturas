import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BotNowStrip from './BotNowStrip';
import BotFlow from './BotFlow';
import KpiCards from './KpiCards';
import PositionRange from './PositionRange';
import SignalsTimeline from './SignalsTimeline';
import Sparkline from './Sparkline';
import PendingBanner from './PendingBanner';
import { contractShort, kpiCardsModel, relativeTime, signalOutcome } from './visualModel';
import BotList from '../BotList';
import { botStatus, flowSteps, normalizeBot, normalizeSignals } from '../botView';
import { pendingEntryRows } from '../botActivity';

const NOW = Date.UTC(2026, 9, 24, 10, 0, 0);
const ENTRY = {
  id: 1, mode: 'live', symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.35, executedQty: 0,
  limitPrice: 712, deadlineAt: NOW + 372_000, bid: 700, ask: 725, feesEstUsdt: 7.14,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function pendingStrip(props = {}) {
  const detail = { pendingEntries: [ENTRY] };
  const status = botStatus({ mode: 'live' }, detail, NOW);
  const [entry] = pendingEntryRows(detail, NOW);
  return render(<BotNowStrip status={status} entry={entry} {...props} />);
}

describe('BotNowStrip', () => {
  it('entrada pendiente: título, cuenta atrás 6:12 y escalera bid/límite/ask', () => {
    pendingStrip();
    expect(screen.getByRole('heading', { name: /Entrada pendiente/ })).toBeTruthy();
    expect(screen.getByText('6:12')).toBeTruthy();
    expect(screen.getByLabelText('Quedan 6 min 12 s')).toBeTruthy();
    expect(screen.getByText('bid 700')).toBeTruthy();
    expect(screen.getByText('límite 712')).toBeTruthy();
    expect(screen.getByText('ask 725')).toBeTruthy();
    expect(screen.getByText('ahorro frente al ask: 13 USDT/contrato')).toBeTruthy();
    expect(screen.getByText(/Comisión est\. 7,14 USDT/)).toBeTruthy();
    expect(screen.getByText(/ejecutado 0 de 0,35/)).toBeTruthy();
  });

  it('la cuenta atrás avanza cada segundo y el temporizador se limpia al desmontar', () => {
    const { unmount } = pendingStrip();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('6:11')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('esperando señal o pausado: sin temporizador', () => {
    const { rerender } = render(<BotNowStrip status={botStatus({ mode: 'shadow' }, {}, NOW)} />);
    expect(screen.getByRole('heading', { name: 'Esperando señal' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    rerender(<BotNowStrip status={botStatus({ mode: 'paused' }, {}, NOW)} />);
    expect(screen.getByRole('heading', { name: 'Pausado' })).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('estado desconocido de la entrada se dice, no se oculta', () => {
    render(<BotNowStrip status={botStatus({ mode: 'live', pendingEntryUnknown: true }, null, NOW)} />);
    expect(screen.getByText('Estado de la entrada desconocido')).toBeTruthy();
  });

  it('bloqueado: «Desbloquear ETH» llama a onUnblock con el subyacente', () => {
    const onUnblock = vi.fn();
    const detail = { blockedUnderlyings: { ETH: { reason: 'partial', at: NOW } } };
    render(<BotNowStrip status={botStatus({ mode: 'live' }, detail, NOW)} blocked={['ETH']} onUnblock={onUnblock} />);
    expect(screen.getByRole('heading', { name: 'Bloqueado: revisa ETH' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear ETH' }));
    expect(onUnblock).toHaveBeenCalledWith('ETH');
  });
});

describe('BotFlow', () => {
  it('pinta los cuatro pasos Señal → Contrato → Entrada → Salida', () => {
    const bot = { structure: 'buy_with', params: { targetDelta: 0.35, expiryDays: 7, takeProfitPct: 80, stopLossPct: 50, exitHoursBeforeExpiry: 12 }, alerts: [{ name: 'MACD cruce 15m', thresholdPercent: 70 }] };
    render(<BotFlow steps={flowSteps(bot)} directions={['bullish', 'bearish']} />);
    const list = screen.getByRole('list', { name: 'Cómo opera el bot' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('b').textContent)).toEqual(['Señal', 'Contrato', 'Entrada', 'Salida']);
    expect(screen.getByText('GTC al precio medio')).toBeTruthy();
    expect(screen.getByText('TP +80 % · Stop −50 %')).toBeTruthy();
    expect(screen.getByText('MACD cruce 15m · umbral 70 %')).toBeTruthy();
  });
});

describe('KpiCards', () => {
  const bot = {
    mode: 'live',
    params: { budgetUsdt: 600, budgetFractions: 4, maxTradesPerDay: 4, maxOpenPositions: 2 },
    usage: { ordersToday: 2 },
    positions: [{ id: 1, mode: 'live', symbol: 'BTC-261024-70000-C', side: 'BUY', quantity: 0.2, entryPrice: 750, closedAt: null }],
    pendingEntries: [ENTRY],
    equity: [{ t: NOW - 5 * 86400e3, shadow: 0, live: 0 }, { t: NOW - 86400e3, shadow: 188.1, live: 214.6 }],
    kpis: {
      shadow: { pnl30dUsdt: 188.1 },
      live: {
        pnl30dUsdt: 214.6, cycles: 9, winRatePct: 66.67, closedTrades: 9, avgPnlUsdt: 23.8, maxDrawdownUsdt: 61.4,
        feesUsdt: 31.85, premiumUsdt: 690, feesPctOfPremium: 4.6,
        feeBreakdown: { entryUsdt: 18.2, exitUsdt: 11.05, exerciseUsdt: 2.6, unallocatedUsdt: 1.5 },
      },
    },
  };

  it('P&L real vs sombra, acierto, comisiones con desglose y presupuesto usado/reservado', () => {
    render(<KpiCards model={kpiCardsModel(bot, NOW)} />);
    expect(screen.getByText('P&L neto 30 d')).toBeTruthy();
    expect(screen.getByLabelText(/Curva de P&L 30 días/)).toBeTruthy();
    expect(screen.getByText('— real +214,60')).toBeTruthy();
    expect(screen.getByText('- - sombra +188,10')).toBeTruthy();
    expect(screen.getByLabelText('66,7 % de acierto')).toBeTruthy();
    expect(screen.getByText('6 de 9 operaciones')).toBeTruthy();
    expect(screen.getByText('31,85 USDT')).toBeTruthy();
    expect(screen.getByText('4,6 % de la prima operada (690 USDT)')).toBeTruthy();
    expect(screen.getByText('entrada 18,20')).toBeTruthy();
    expect(screen.getByText('ejercicio 2,60')).toBeTruthy();
    expect(screen.getByText('sin desglose (histórico) 1,50')).toBeTruthy();
    // 0,2 × 750 = 150 usado; 0,35 × 712 = 249,2 reservado.
    expect(screen.getByLabelText('Presupuesto: 150 usado y 249,2 reservado de 600 USDT')).toBeTruthy();
    expect(screen.getByText('1 posición + 1 entrada pendiente · 2 fracciones libres')).toBeTruthy();
    expect(screen.getByText('Operaciones hoy 2 / 4')).toBeTruthy();
  });

  it('compacto (teléfono): 2×2 con mini curva, «Comisiones» con % de la prima, acierto y presupuesto con barra', () => {
    const { container } = render(<KpiCards model={kpiCardsModel(bot, NOW)} compact />);
    expect(screen.getByText('P&L neto 30 d')).toBeTruthy();
    expect(screen.getByLabelText(/Curva de P&L 30 días/)).toBeTruthy();
    expect(screen.getByText('Comisiones')).toBeTruthy();
    expect(screen.getByText('4,6 % de la prima')).toBeTruthy();
    expect(screen.getByLabelText('66,7 % de acierto')).toBeTruthy();
    expect(screen.getByText('6 de 9')).toBeTruthy();
    expect(screen.getByText('2 fracciones libres')).toBeTruthy();
    expect(screen.getByLabelText(/^Presupuesto:/)).toBeTruthy();
    // Sin desgloses ni leyendas en el teléfono.
    expect(screen.queryByText('entrada 18,20')).toBeNull();
    expect(screen.queryByText('— real +214,60')).toBeNull();
    expect(container.querySelectorAll('[role="img"]').length).toBeGreaterThanOrEqual(4);
  });

  it('con pocas operaciones el acierto es n/a', () => {
    const few = { ...bot, kpis: { live: { cycles: 2, winRatePct: 50, closedTrades: 2 } } };
    render(<KpiCards model={kpiCardsModel(few, NOW)} />);
    expect(screen.getByText('n/a')).toBeTruthy();
    expect(screen.getByText(/mínimo 5 operaciones cerradas/)).toBeTruthy();
  });
});

describe('PositionRange', () => {
  it('stop, entrada, ahora y TP sobre la barra, con aria-label del valor', () => {
    render(<PositionRange stop={452} entry={905} mark={1111} tp={1629} />);
    const bar = screen.getByRole('img', { name: /Precio actual 1\.111 entre stop 452 y objetivo 1\.629/ });
    expect(bar).toBeTruthy();
    expect(screen.getByText('stop 452')).toBeTruthy();
    expect(screen.getByText('entrada 905')).toBeTruthy();
    expect(screen.getByText('ahora 1.111')).toBeTruthy();
    expect(screen.getByText('TP 1.629')).toBeTruthy();
  });
});

describe('SignalsTimeline', () => {
  const signals = normalizeSignals([
    { id: 1, direction: 'bullish', asset: 'BTCUSDT', decision: 'pending', detail: 'Compra 0,35 C 70.000 a 712 (medio) · GTC 10 min', feesUsdt: 7.14, feesEstimated: true, createdAt: NOW - 4 * 60e3 },
    { id: 2, direction: 'bearish', asset: 'BTCUSDT', decision: 'ignored', detail: 'Real: Entrada sin ejecutar en 10 min', createdAt: NOW - 3600e3 * 20 },
    { id: 3, direction: 'bullish', asset: 'BTCUSDT', decision: 'opened', detail: 'Compra 0,20 C 70.000 a 905', feesUsdt: 4.08, createdAt: NOW - 3 * 86400e3 },
    { id: 4, direction: 'bearish', asset: 'BTCUSDT', decision: 'ignored', detail: 'Ya hay una opción abierta en BTC', createdAt: NOW - 4 * 86400e3 },
  ]);

  it('icono de dirección, resultado y línea de comisión', () => {
    render(<SignalsTimeline signals={signals} now={NOW} />);
    const list = screen.getByRole('list', { name: 'Señales' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]).getByText('Entrada pendiente')).toBeTruthy();
    expect(within(items[0]).getByText('Comisión est. 7,14 USDT')).toBeTruthy();
    expect(within(items[0]).getByText('hace 4 min')).toBeTruthy();
    expect(within(items[1]).getByText('Sin ejecutar')).toBeTruthy();
    expect(within(items[1]).getByText('Sin comisión')).toBeTruthy();
    expect(within(items[2]).getByText('Abierta')).toBeTruthy();
    expect(within(items[2]).getByText('Comisión 4,08 USDT')).toBeTruthy();
    expect(within(items[3]).getByText('Ignorada')).toBeTruthy();
    expect(within(items[3]).getByText('Ya hay una opción abierta en BTC')).toBeTruthy();
  });

  it('resultados y tiempos relativos', () => {
    expect(signalOutcome({ decision: 'ignored', detail: 'Real: Entrada cancelada por señal contraria' }).label).toBe('Cancelada');
    expect(signalOutcome({ decision: 'error' }).label).toBe('Error');
    expect(relativeTime(NOW - 30e3, NOW)).toBe('ahora');
    expect(relativeTime(NOW - 2 * 3600e3, NOW)).toBe('hace 2 h');
  });
});

describe('Sparkline', () => {
  it('SVG con aria-label del último valor; sin datos no pinta nada', () => {
    const { container, rerender } = render(<Sparkline values={[0, 10, 5, 214.6]} />);
    expect(screen.getByRole('img', { name: 'P&L 30 días: +214,60' })).toBeTruthy();
    rerender(<Sparkline values={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('BotList', () => {
  it('punto de estado «Real», chip «Entrada 6:12» que cuenta atrás y sparkline', () => {
    const bots = [normalizeBot({
      id: 1, name: 'Momentum BTC', template: 'alert_signal', underlying: 'BTC', mode: 'live', status: 'waiting',
      params: { structure: 'buy_with' }, alerts: [{ id: 1, name: 'up', direction: 'bullish' }],
      pnl30d: { shadow: 100, live: 214.6 }, pnlSeries: [0, 50, 120, 214.6],
      pendingEntry: { deadlineAt: NOW + 372_000 },
    })];
    const { container } = render(<BotList bots={bots} selectedId={1} onSelect={() => {}} />);
    expect(container.querySelector('[title="Real"]')).toBeTruthy();
    expect(screen.getByText('Entrada 6:12')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'P&L 30 días: +214,60' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Entrada 6:11')).toBeTruthy();
  });

  it('sin entradas pendientes las horas relativas avanzan en cada render (y sin temporizador)', () => {
    const make = (at) => [normalizeBot({
      id: 3, name: 'BTC', underlying: 'BTC', mode: 'shadow', params: { structure: 'buy_with' }, alerts: [],
      lastSignal: { direction: 'bullish', decision: 'opened', createdAt: at },
    })];
    const { rerender } = render(<BotList bots={make(NOW - 4 * 60e3)} selectedId={3} onSelect={() => {}} />);
    expect(screen.getByText(/hace 4 min/)).toBeTruthy();
    vi.setSystemTime(NOW + 6 * 60e3);
    rerender(<BotList bots={make(NOW - 4 * 60e3)} selectedId={3} onSelect={() => {}} />);
    expect(screen.getByText(/hace 10 min/)).toBeTruthy();
    // Una señal posterior al montaje no sale como «ahora» congelado ni como fecha.
    rerender(<BotList bots={make(NOW + 4 * 60e3)} selectedId={3} onSelect={() => {}} />);
    expect(screen.getByText(/hace 2 min/)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sin entradas pendientes no hay temporizador', () => {
    const bots = [normalizeBot({ id: 2, name: 'SOL', underlying: 'SOL', mode: 'shadow', params: {}, alerts: [] })];
    const { container } = render(<BotList bots={bots} selectedId={2} onSelect={() => {}} />);
    expect(container.querySelector('[title="Sombra"]')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PendingBanner', () => {
  const bots = [
    normalizeBot({ id: 1, name: 'Momentum BTC', mode: 'live', params: {}, alerts: [], pendingEntry: { deadlineAt: NOW + 372_000 } }),
    normalizeBot({ id: 2, name: 'Lotería', mode: 'paused', params: {}, alerts: [] }),
  ];
  const [entry] = pendingEntryRows({ pendingEntries: [ENTRY] }, NOW);

  it('«1 entrada pendiente · 6:12», bot y contrato al límite; cuenta atrás y limpia el temporizador', () => {
    const onSelect = vi.fn();
    const { unmount } = render(<PendingBanner bots={bots} entry={{ botId: 1, row: entry }} onSelect={onSelect} />);
    const btn = screen.getByRole('button', { name: /1 entrada pendiente · 6:12/ });
    expect(within(btn).getByText('Momentum BTC · C 70.000 a 712')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('1 entrada pendiente · 6:11')).toBeTruthy();
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sin entradas pendientes no pinta nada ni crea temporizador', () => {
    const { container } = render(<PendingBanner bots={[bots[1]]} onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('varias: cuenta, la que vence antes, y sin contrato si el detalle no es de ese bot', () => {
    const two = [...bots, normalizeBot({ id: 3, name: 'ETH swing', mode: 'shadow', params: {}, alerts: [], pendingEntry: { deadlineAt: NOW + 60_000 } })];
    render(<PendingBanner bots={two} entry={{ botId: 1, row: entry }} onSelect={() => {}} />);
    expect(screen.getByText('2 entradas pendientes · 1:00')).toBeTruthy();
    expect(screen.getByText('ETH swing · y 1 más')).toBeTruthy();
  });

  it('contractShort: tipo y strike', () => {
    expect(contractShort('BTC-261031-70000-C')).toBe('C 70.000');
    expect(contractShort('XRP-261031-2.5-P')).toBe('P 2,5');
    expect(contractShort('raro')).toBe('raro');
  });
});

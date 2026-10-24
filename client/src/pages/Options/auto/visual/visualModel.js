// Derivaciones puras para los componentes visuales del detalle del bot
// (tarjetas KPI, cronología de señales). Sin red; el reloj entra por `now`.
import { formatDateTime, formatNumber, toMs, toNumber } from '../../strategies/common/format';
import { buildEquity } from '../../strategies/strategyView';
import { MIN_TRADES_FOR_WIN_RATE, feeSummary } from '../botView';

const DAY_MS = 24 * 60 * 60 * 1000;
const list = (v) => (Array.isArray(v) ? v : []);
const round = (n) => Math.round(n * 1e8) / 1e8;
const pad = (n) => String(n).padStart(2, '0');

// «C 70.000» a partir de «BTC-261031-70000-C»: tipo y strike, lo que cabe en
// una línea de teléfono. Si el símbolo no tiene esa forma se devuelve tal cual.
export function contractShort(symbol) {
  const m = /-(\d+(?:\.\d+)?)-([CP])$/.exec(String(symbol ?? ''));
  if (!m) return String(symbol ?? '');
  return `${m[2]} ${formatNumber(Number(m[1]), { decimals: 4, minDecimals: 0 })}`;
}

// «ahora», «hace 4 min», «hace 2 h», «ayer 18:40» o «22 oct 09:15».
export function relativeTime(at, now = Date.now()) {
  const ms = toMs(at);
  if (ms === null) return '—';
  const diff = now - ms;
  if (diff < 60_000 && diff > -60_000) return 'ahora';
  if (diff > 0 && diff < 3600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (diff > 0 && sameDay) return `hace ${Math.floor(diff / 3600_000)} h`;
  const yesterday = new Date(now - DAY_MS);
  if (d.toDateString() === yesterday.toDateString()) return `ayer ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return formatDateTime(ms);
}

// Resultado de una señal como píldora: texto y tono (up | wait | mute | down).
export function signalOutcome(signal = {}) {
  const detail = String(signal.detail || '');
  switch (signal.decision) {
    case 'pending': return { label: 'Entrada pendiente', tone: 'wait' };
    case 'opened': return { label: 'Abierta', tone: 'up' };
    case 'closed': return { label: 'Cerrada', tone: 'mute' };
    case 'reversed': return { label: 'Girada', tone: 'mute' };
    case 'error': return { label: 'Error', tone: 'down' };
    case 'ignored':
      if (/sin ejecutar/i.test(detail)) return { label: 'Sin ejecutar', tone: 'mute', noFill: true };
      if (/cancelada/i.test(detail)) return { label: 'Cancelada', tone: 'mute', noFill: true };
      if (/rechazada/i.test(detail)) return { label: 'Rechazada', tone: 'down', noFill: true };
      return { label: 'Ignorada', tone: 'mute' };
    default: return { label: signal.decisionLabel || '—', tone: 'mute' };
  }
}

// Curva de los últimos `days` días, rebasada a 0 al inicio de la ventana.
// Devuelve x en 0–1 (tiempo) para cada libro.
export function pnlCurve(equity, now = Date.now(), days = 30) {
  const eq = buildEquity(equity);
  const cutoff = now - days * DAY_MS;
  const series = (key) => {
    let base = null;
    const pts = [];
    eq.times.forEach((t, i) => {
      const v = eq[key][i];
      if (v === null) return;
      if (t < cutoff) base = v;
      else pts.push({ t, v });
    });
    if (base === null && !pts.length) return [];
    // Con historia previa a la ventana, la curva arranca en el corte con el
    // acumulado de entonces; si no, en el primer punto (alta del bot).
    const all = base === null ? pts : [{ t: cutoff, v: base }, ...pts];
    const last = all[all.length - 1];
    if (last.t < now) all.push({ t: now, v: last.v });
    const start = all[0].t;
    const span = Math.max(1, now - start);
    return all.map((p) => ({ x: Math.min(1, Math.max(0, (p.t - start) / span)), y: round(p.v - (base ?? 0)) }));
  };
  return { shadow: series('shadow'), live: eq.hasLive ? series('live') : [] };
}

// Modelo de las cuatro tarjetas KPI del libro activo (real si el bot está en real).
export function kpiCardsModel(bot = {}, now = Date.now()) {
  const mode = bot.mode === 'live' ? 'live' : 'shadow';
  const k = bot.kpis && typeof bot.kpis === 'object' ? bot.kpis : {};
  const active = (k[mode] && typeof k[mode] === 'object') ? k[mode] : {};
  const pnlShadow = toNumber(k.shadow?.pnl30dUsdt) ?? bot.pnlShadow ?? null;
  const pnlLive = toNumber(k.live?.pnl30dUsdt) ?? bot.pnlLive ?? null;

  const cycles = toNumber(active.cycles);
  const winRate = toNumber(active.winRatePct);
  const closedTrades = toNumber(active.closedTrades);
  const few = closedTrades !== null && closedTrades < MIN_TRADES_FOR_WIN_RATE;

  const params = bot.params || {};
  const usage = bot.usage || {};
  const open = list(bot.positions).filter((p) => p.closedAt == null && (p.mode || 'shadow') === mode);
  const pending = list(bot.pendingEntries).filter((e) => (e.mode || 'shadow') === mode);
  const used = round(open.reduce((a, p) => a + (toNumber(p.entryPrice) ?? 0) * (toNumber(p.quantity) ?? 0), 0));
  const reserved = round(pending.reduce((a, e) => a + (toNumber(e.limitPrice) ?? 0)
    * Math.max(0, (toNumber(e.quantity) ?? 0) - (toNumber(e.executedQty) ?? 0)), 0));
  const budget = toNumber(params.budgetUsdt);
  const fractions = toNumber(params.budgetFractions);

  return {
    mode,
    pnl: {
      value: mode === 'live' ? pnlLive : pnlShadow,
      live: pnlLive,
      shadow: pnlShadow,
      curve: pnlCurve(bot.equity, now),
    },
    win: {
      pct: few ? null : winRate,
      wins: cycles !== null && winRate !== null ? Math.round((cycles * winRate) / 100) : null,
      total: cycles,
      few,
      closedTrades,
      avg: toNumber(active.avgPnlUsdt),
      drawdown: toNumber(active.maxDrawdownUsdt),
    },
    fees: { ...feeSummary(active), premium: toNumber(active.premiumUsdt) },
    budget: {
      budget: budget > 0 ? budget : null,
      used,
      reserved,
      openCount: open.length,
      pendingCount: pending.length,
      freeFractions: budget > 0 && fractions > 0 ? Math.max(0, fractions - open.length - pending.length) : null,
      ordersToday: toNumber(usage.ordersToday) ?? 0,
      maxTrades: toNumber(params.maxTradesPerDay),
      maxOpen: toNumber(params.maxOpenPositions),
    },
  };
}

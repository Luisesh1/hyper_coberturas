/**
 * P&L realizado acumulado por día (UTC) de un libro: `days` puntos, el más
 * antiguo primero. Cada punto incluye lo cerrado antes de la ventana.
 */
const DAY_MS = 86_400_000;

function dailyPnlSeries(positions, mode, now, days = 30) {
  const closed = positions.filter((p) => p.mode === mode && p.closedAt != null && Number.isFinite(p.pnlUsdt));
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const series = [];
  for (let k = days - 1; k >= 0; k -= 1) {
    const end = todayStart - k * DAY_MS + DAY_MS;
    let sum = 0;
    for (const p of closed) if (p.closedAt < end) sum += p.pnlUsdt;
    series.push(Math.round(sum * 100) / 100);
  }
  return series;
}

module.exports = { dailyPnlSeries };

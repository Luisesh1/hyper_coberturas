/**
 * Calibración del backtest sintético frente a las posiciones de sombra. SOLO LECTURA.
 *
 * Corre el backtest existente con los parámetros del bot sobre el periodo de su
 * sombra y empareja cada ciclo sintético con las posiciones de sombra reales
 * (mismo subyacente, apertura a +-30 min). No escribe en la base (no persiste la
 * corrida del backtest), ni envía órdenes.
 *
 * Uso (dentro del contenedor):
 *   docker exec testbot-server node src/scripts/options-backtest-calibration.js \
 *     --strategy <id> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--underlying BTC] [--source realized|dvol] [--json]
 *
 * Un bot multi-subyacente se backtestea una vez por subyacente (o solo --underlying).
 * Por defecto el periodo va de la primera posición de sombra a ahora. El backtest
 * exige un rango mínimo de 2 días: si el periodo es menor se amplía hacia atrás
 * y solo se comparan operaciones desde el inicio pedido.
 */
const { createOptionsBacktestService } = require('../services/options/options-backtest.service');
const { pairTrades, summarize, formatReport, mergeResults, parseArgs, parseDay } = require('../services/options/options-calibration');
const { botUnderlyings } = require('../services/options/bot-underlyings');
const { DAY_MS, parseSymbol } = require('../services/options/options-utils');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const strategiesRepo = require('../repositories/options-strategies.repository');
  const strategy = await strategiesRepo.getStrategyById(Number(args.strategy));
  if (!strategy) throw new Error(`Estrategia ${args.strategy} no encontrada`);

  const shadow = (await strategiesRepo.listPositions(strategy.id)).filter((p) => p.mode === 'shadow');
  if (!shadow.length) throw new Error('La estrategia no tiene posiciones de sombra');
  const since = parseDay(args.since, '--since') ?? Math.min(...shadow.map((p) => p.openedAt));
  const until = parseDay(args.until, '--until') ?? Date.now();
  if (!(since < until)) throw new Error('--since debe ser anterior a --until');

  const wanted = args.underlying ? [args.underlying] : botUnderlyings(strategy);
  const service = createOptionsBacktestService();
  const inPeriod = (t) => t >= since && t <= until;
  const results = [];
  const byUnderlying = {};
  const notes = {};
  for (const underlying of wanted) {
    const config = await service.normalizeConfig(strategy.userId, {
      strategyId: strategy.id,
      underlying,
      from: Math.min(since, until - 2 * DAY_MS),
      to: until,
      ...(args.source ? { source: args.source } : {}),
    });
    const result = await service.runBacktest(config);
    const positions = shadow.filter((p) => inPeriod(p.openedAt) && parseSymbol(p.symbol)?.underlying === underlying);
    const cycles = result.cycles.filter((c) => inPeriod(c.openedAt));
    const paired = pairTrades({ cycles, positions });
    results.push(paired);
    byUnderlying[underlying] = summarize(paired);
    notes[underlying] = result.sourceNote;
  }
  const paired = mergeResults(results);
  const report = { strategyId: strategy.id, from: since, until, summary: summarize(paired), byUnderlying, ...paired };

  process.stdout.write(args.json ? `${JSON.stringify({ ...report, sourceNotes: notes }, null, 2)}\n` : `${formatReport(report)}\n`);
}

main().catch((err) => {
  process.stderr.write(`Calibración fallida: ${err.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  // El pool solo existe si se llegó a abrir la conexión.
  try { require('../db').pool.end(); } catch { /* sin pool */ }
});

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
 *     --strategy <id> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--source realized|dvol] [--json]
 *
 * Por defecto el periodo va de la primera posición de sombra a ahora. El backtest
 * exige un rango mínimo de 2 días: si el periodo es menor se amplía hacia atrás
 * y solo se comparan operaciones desde el inicio pedido.
 */
const { createOptionsBacktestService } = require('../services/options/options-backtest.service');
const { pairTrades, summarize, formatReport } = require('../services/options/options-calibration');
const { DAY_MS } = require('../services/options/options-utils');

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (['--strategy', '--since', '--until', '--source'].includes(a)) { args[a.slice(2)] = argv[i + 1]; i += 1; }
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  if (!/^\d+$/.test(String(args.strategy || ''))) throw new Error('Falta --strategy <id>');
  return args;
}

function parseDay(value, name) {
  if (value == null) return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${name} debe ser YYYY-MM-DD`);
  return ms;
}

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

  const service = createOptionsBacktestService();
  const config = await service.normalizeConfig(strategy.userId, {
    strategyId: strategy.id,
    from: Math.min(since, until - 2 * DAY_MS),
    to: until,
    ...(args.source ? { source: args.source } : {}),
  });
  const result = await service.runBacktest(config);

  const inPeriod = (t) => t >= since && t <= until;
  const positions = shadow.filter((p) => inPeriod(p.openedAt));
  const cycles = result.cycles.filter((c) => inPeriod(c.openedAt));
  const paired = pairTrades({ cycles, positions });
  const report = { strategyId: strategy.id, from: since, until, summary: summarize(paired), ...paired };

  process.stdout.write(args.json ? `${JSON.stringify({ ...report, sourceNote: result.sourceNote }, null, 2)}\n` : `${formatReport(report)}\n`);
}

main().catch((err) => {
  process.stderr.write(`Calibración fallida: ${err.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  // El pool solo existe si se llegó a abrir la conexión.
  try { require('../db').pool.end(); } catch { /* sin pool */ }
});

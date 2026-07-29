/**
 * weekly-hedge-report.js
 *
 * Reporte semanal (SOLO LECTURA) del desempeño de las coberturas delta-neutral,
 * enviado por Telegram. Pensado para correr por cron dentro del contenedor del
 * server (reusa la env/clave de cifrado del app):
 *
 *   docker exec testbot-server-prod node /app/weekly-hedge-report.js [dias]
 *
 * - Métricas: efectividad del hedge (corr LP/HL, beta), riesgo de liquidación,
 *   cobertura efectiva, time-in-range, calidad de datos y accounting acumulado.
 *   Marco documentado en la memoria `hedge-periodic-analysis`.
 * - Envío: a todos los chats de Telegram configurados y habilitados (creds
 *   descifradas vía settingsService). Override opcional: TELEGRAM_REPORT_CHAT_ID.
 * - Flags: `--dry-run` imprime el mensaje y NO envía (para validar).
 *
 * NO ejecuta ninguna escritura contra prod: solo SELECT + sendMessage.
 */

const db = require('./src/db');
const settingsService = require('./src/services/settings.service');
const TelegramService = require('./src/services/telegram.service');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WIN_DAYS = Number(args.find((a) => /^\d+$/.test(a)) || 7);
const WIN_MS = WIN_DAYS * 86400000;

function fmtSigned(n) {
  if (n == null || Number.isNaN(Number(n))) return 'N/A';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

// Semáforo simple para umbrales conocidos (ver memoria hedge-periodic-analysis).
function liqEmoji(dist) {
  if (dist == null) return '⚪';
  if (dist < 8) return '🔴';
  if (dist < 12) return '🟠';
  return '🟢';
}
function corrEmoji(c) {
  if (c == null) return '⚪';
  return c <= -0.6 ? '🟢' : c <= -0.3 ? '🟠' : '🔴';
}

async function collect() {
  const since = Date.now() - WIN_MS;

  const [eff, risk, cov, dq, tir, acc] = await Promise.all([
    // Efectividad sobre PRIMERAS DIFERENCIAS (Δlp vs Δhl entre snapshots
    // consecutivos): en ventana semanal los niveles no son estacionarios
    // (rebalanceos y cambios de rango mueven el tamaño de ambas patas y lavan
    // la correlación de niveles). Los Δ son intra-régimen. Se filtran los saltos
    // de rebalanceo/aporte (|Δ|>1.5 USD; los movimientos normales son <0.5).
    db.query(
      `WITH s AS (
         SELECT orchestrator_id oid, total_usd t,
           lp_usd - lag(lp_usd) OVER w AS dlp,
           hl_account_usd - lag(hl_account_usd) OVER w AS dhl
         FROM orchestrator_metrics_snapshots
         WHERE captured_at >= $1 AND hl_account_usd > 0 AND total_usd > 50
         WINDOW w AS (PARTITION BY orchestrator_id ORDER BY captured_at))
       SELECT oid, count(*) snaps,
         round(avg(t)::numeric,2) avg_total,
         round((stddev(t)/nullif(avg(t),0)*100)::numeric,3) cv_pct,
         round(corr(dlp,dhl) FILTER (WHERE abs(dlp) < 1.5 AND abs(dhl) < 1.5)::numeric,3) corr_lp_hl,
         round((-regr_slope(dhl,dlp) FILTER (WHERE abs(dlp) < 1.5 AND abs(dhl) < 1.5))::numeric,3) hedge_beta
       FROM s GROUP BY oid ORDER BY oid`,
      [since],
    ),
    db.query(
      `SELECT protected_pool_id pp,
         round(min(distance_to_liq_pct)::numeric,1) min_dist_liq,
         count(*) rebalances
       FROM protected_pool_delta_rebalance_log
       WHERE created_at >= $1
       GROUP BY protected_pool_id ORDER BY protected_pool_id`,
      [since],
    ),
    db.query(
      `SELECT DISTINCT ON (protected_pool_id) protected_pool_id pp,
         round((target_qty_after/nullif(delta_qty_before,0))::numeric,2) ratio
       FROM protected_pool_delta_rebalance_log
       WHERE created_at >= $1
       ORDER BY protected_pool_id, created_at DESC`,
      [since],
    ),
    db.query(
      `SELECT orchestrator_id oid,
         count(*) FILTER (WHERE hl_account_usd = 0
           AND breakdown_json->>'hlStatus' IN ('not_linked','unavailable')) anomalias
       FROM orchestrator_metrics_snapshots
       WHERE captured_at >= $1
       GROUP BY orchestrator_id ORDER BY orchestrator_id`,
      [since],
    ),
    db.query(
      `SELECT orchestrator_id oid,
         round(100.0*count(*) FILTER (
           WHERE current_price BETWEEN range_lower_price AND range_upper_price)
           /nullif(count(*),0),1) tir
       FROM lp_orchestrator_action_log
       WHERE created_at >= $1 AND current_price IS NOT NULL
         AND range_lower_price IS NOT NULL AND range_upper_price IS NOT NULL
       GROUP BY orchestrator_id ORDER BY orchestrator_id`,
      [since],
    ),
    db.query(
      `SELECT id,
         round((accounting_json::json->>'lpFeesUsd')::numeric,2) fees,
         round(((accounting_json::json->>'priceDriftUsd')::numeric
              + (accounting_json::json->>'hedgeRealizedPnlUsd')::numeric
              + (accounting_json::json->>'hedgeFundingUsd')::numeric),2) residual,
         round((accounting_json::json->>'totalNetPnlUsd')::numeric,2) net_pnl
       FROM lp_orchestrators
       WHERE accounting_json IS NOT NULL AND accounting_json::json->>'totalNetPnlUsd' IS NOT NULL
       ORDER BY id`,
      [],
    ),
  ]);

  const idx = (rows, key) => new Map(rows.map((r) => [Number(r[key]), r]));
  return {
    active: eff.rows.map((r) => Number(r.oid)),
    eff: idx(eff.rows, 'oid'),
    risk: idx(risk.rows, 'pp'),
    cov: idx(cov.rows, 'pp'),
    dq: idx(dq.rows, 'oid'),
    tir: idx(tir.rows, 'oid'),
    acc: idx(acc.rows, 'id'),
  };
}

function buildMessage(d) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `📊 <b>Reporte semanal de coberturas</b> (${WIN_DAYS}d)`,
    `<i>${now}Z · db hyperbot</i>`,
  ];

  if (d.active.length === 0) {
    lines.push('', '⚠️ Sin orquestadores con datos en la ventana.');
    return lines.join('\n');
  }

  let anomaliasTot = 0;
  for (const oid of d.active) {
    const e = d.eff.get(oid) || {};
    const r = d.risk.get(oid) || {};
    const c = d.cov.get(oid) || {};
    const q = d.dq.get(oid) || {};
    const t = d.tir.get(oid) || {};
    const a = d.acc.get(oid) || {};
    anomaliasTot += Number(q.anomalias || 0);

    const dist = r.min_dist_liq != null ? Number(r.min_dist_liq) : null;
    const corr = e.corr_lp_hl != null ? Number(e.corr_lp_hl) : null;

    lines.push(
      '',
      `<b>▎Orquestador #${oid}</b>`,
      `${liqEmoji(dist)} Dist. liquidación mín: <b>${dist != null ? dist + '%' : 'N/A'}</b>`
        + `  (umbral 8%)`,
      `${corrEmoji(corr)} Hedge tracking (Δcorr LP/HL): <b>${corr != null ? corr : 'N/A'}</b>`
        + ` · cobertura β <b>${e.hedge_beta ?? 'N/A'}</b>`,
      `• Cobertura efectiva: <b>${c.ratio ?? 'N/A'}</b>  (objetivo ~1.0)`,
      `• Time-in-range: <b>${t.tir != null ? t.tir + '%' : 'N/A'}</b>`
        + ` · CV total: ${e.cv_pct ?? 'N/A'}%`,
      `• Acumulado: net PnL <b>${fmtSigned(a.net_pnl)}</b>`
        + ` · residual ${fmtSigned(a.residual)} · fees ${fmtSigned(a.fees)}`,
    );
  }

  lines.push(
    '',
    `${anomaliasTot === 0 ? '🟢' : '🔴'} Calidad de datos: `
      + `<b>${anomaliasTot}</b> anomalías hl=0 (debe ser 0)`,
    '',
    `<i>Lectura: dist&lt;8% = margen apretado · Δcorr≤−0.6 = short trackea el delta · `
      + `β = fracción cubierta (sube hacia 1.0 al dominar el régimen post-cambio) · `
      + `net PnL/residual revierten lento (deuda del régimen 0.6).</i>`,
  );
  return lines.join('\n');
}

async function main() {
  const data = await collect();
  const message = buildMessage(data);

  if (DRY_RUN) {
    console.log(message);
    return;
  }

  const overrideChat = String(process.env.TELEGRAM_REPORT_CHAT_ID || '').trim();
  const configs = await settingsService.listTelegramConfigs();
  const targets = overrideChat
    ? configs.slice(0, 1).map((c) => ({ ...c, chatId: overrideChat }))
    : configs;

  if (targets.length === 0) {
    console.error('weekly-hedge-report: no hay configs de Telegram habilitadas.');
    process.exitCode = 1;
    return;
  }

  let sent = 0;
  for (const cfg of targets) {
    const tg = new TelegramService(cfg.token, cfg.chatId);
    const res = await tg.send(message);
    if (res) sent += 1;
    else console.error(`weekly-hedge-report: fallo enviando a chat ${cfg.chatId}`);
  }
  console.log(`weekly-hedge-report: enviado a ${sent}/${targets.length} chat(s).`);
}

main()
  .catch((err) => {
    console.error('weekly-hedge-report error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // El pool mantiene el proceso vivo; cerrarlo para que el cron termine.
    db.pool?.end?.().catch(() => {});
  });

/**
 * weekly-hedge-report.js
 *
 * Reporte semanal (SOLO LECTURA) del desempeño de las coberturas delta-neutral,
 * enviado por Telegram. Pensado para correr por cron dentro del contenedor del
 * server (reusa la env/clave de cifrado del app):
 *
 *   docker exec testbot-server-prod node /app/weekly-hedge-report.js [dias]
 *
 * - Métricas: cobertura real (actualQty/deltaQty), riesgo de liquidación, coste
 *   de ejecución del hedge, time-in-range, calidad de datos y accounting.
 *   Marco documentado en la memoria `hedge-periodic-analysis`.
 * - OJO: `hedge_beta` y `corr LP/HL` se imprimen solo como diagnóstico y van
 *   marcados como NO FIABLES. Se calculan sobre `hl_account_usd` y las dos patas
 *   no se muestrean sincronizadas (`lp_usd` se queda congelado en hasta el 53%
 *   de los intervalos), lo que hunde la pendiente hacia 0: daban 0.29-0.50
 *   cuando la cobertura real era 0.99-1.10. No decidir nada con ellas.
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
// La cobertura ideal es 1.0. Desviarse cuesta dinero en AMBAS direcciones:
// por debajo queda delta sin cubrir, por encima quedas net-short.
function cobEmoji(c) {
  if (c == null) return '⚪';
  const d = Math.abs(Number(c) - 1);
  return d <= 0.03 ? '🟢' : d <= 0.10 ? '🟠' : '🔴';
}
// Mismo umbral de 1/3 que usa el recomendador de rango para bloquear el
// angostamiento: por encima, cubrir se come mas de un tercio de lo que rinde.
function costEmoji(ratio) {
  if (ratio == null) return '⚪';
  return ratio < 0.2 ? '🟢' : ratio < 0.3333 ? '🟠' : '🔴';
}

async function collect() {
  const since = Date.now() - WIN_MS;

  const [eff, risk, cobertura, cov, dq, tir, acc] = await Promise.all([
    // Efectividad sobre PRIMERAS DIFERENCIAS (Δlp vs Δhl entre snapshots
    // consecutivos): en ventana semanal los niveles no son estacionarios
    // (rebalanceos y cambios de rango mueven el tamaño de ambas patas y lavan
    // la correlación de niveles). Los Δ son intra-régimen. Se filtran los saltos
    // de rebalanceo/aporte con un umbral RELATIVO al tamaño (1% del total) en vez
    // del absoluto de 1.5 USD anterior, que estaba calibrado para orquestadores
    // de ~$140 y no escala. Verificado el 2026-08-10: a los tamaños actuales
    // ambos umbrales dan el MISMO beta (#37 = 0.293), o sea que esto no corrige
    // un sesgo observado — es invariancia de escala para cuando crezcan.
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
         round(corr(dlp,dhl) FILTER (WHERE abs(dlp) < 0.01*t AND abs(dhl) < 0.01*t)::numeric,3) corr_lp_hl,
         round((-regr_slope(dhl,dlp) FILTER (WHERE abs(dlp) < 0.01*t AND abs(dhl) < 0.01*t))::numeric,3) hedge_beta
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
    // COBERTURA REAL: actualQty/deltaQty leido del strategy_state, o sea las dos
    // cantidades tal como las vio el MISMO ciclo de evaluacion. Es la unica
    // medida fiable — ver el bloque de `hedge_beta` mas abajo.
    db.query(
      `SELECT p.id pp, o.id oid,
         round(((p.strategy_state_json::json->>'lastActualQty')::numeric
              / nullif((p.strategy_state_json::json->>'lastDeltaQty')::numeric,0)),4) cobertura
       FROM protected_uniswap_pools p
       JOIN lp_orchestrators o ON o.active_protected_pool_id = p.id
       WHERE p.strategy_state_json IS NOT NULL`,
      [],
    ),
    // Costo de ejecucion de la cobertura: es el segundo sumidero medido el
    // 2026-08-10 y no se reportaba. Sustituye a la vieja query de "cobertura
    // efectiva" (target_qty_after/delta_qty_before), que era tautologica —los
    // tres campos se escriben del mismo valor en el rebalanceo, asi que daba
    // 1.00 siempre— y ademas se leia mal: devolvia protected_pool_id pero se
    // consultaba por orchestrator_id, con lo que casi siempre salia 'N/A'.
    db.query(
      `SELECT id oid,
         round(((accounting_json::json->>'hedgeExecutionFeesUsd')::numeric
              + (accounting_json::json->>'hedgeSlippageUsd')::numeric),2) exec_cost,
         round(((accounting_json::json->>'hedgeExecutionFeesUsd')::numeric
              + (accounting_json::json->>'hedgeSlippageUsd')::numeric)
              / nullif((accounting_json::json->>'lpFeesUsd')::numeric,0),2) cost_ratio
       FROM lp_orchestrators
       WHERE accounting_json IS NOT NULL
       ORDER BY id`,
      [],
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
    cobertura: idx(cobertura.rows, 'oid'),
    cov: idx(cov.rows, 'oid'),
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
    const cb = d.cobertura.get(oid) || {};
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
      `${cobEmoji(cb.cobertura)} Cobertura real (actual/delta): `
        + `<b>${cb.cobertura != null ? Math.round(Number(cb.cobertura) * 100) + '%' : 'N/A'}</b>`,
      // `hedge_beta` se conserva SOLO como diagnostico y marcado como no fiable:
      // se calcula sobre `hl_account_usd`, y las dos patas no se muestrean
      // sincronizadas — `lp_usd` se queda congelado en hasta el 53% de los
      // intervalos mientras el lado HL si se actualiza. Eso es error en la
      // variable independiente y hunde la pendiente hacia 0. Daba 0.29-0.50
      // cuando la cobertura real era 0.99-1.10. No usarlo para decidir nada.
      `<i>· diag. no fiable: Δcorr ${corr != null ? corr : 'N/A'}`
        + ` · β ${e.hedge_beta ?? 'N/A'} (subestima, patas asíncronas)</i>`,
      // Ojo: `accounting_json` es acumulado de por vida, NO de la ventana del
      // reporte. Se etiqueta explicito para no leerlo como coste semanal.
      `${costEmoji(c.cost_ratio)} Costo cobertura (acum.): <b>${fmtSigned(c.exec_cost)}</b>`
        + ` = <b>${c.cost_ratio != null ? Math.round(Number(c.cost_ratio) * 100) + '%' : 'N/A'}</b> de las fees`,
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
    `<i>Lectura: dist&lt;8% = margen apretado · cobertura 100% = delta cubierto `
      + `(por debajo queda expuesto, por encima quedas net-short) · `
      + `costo&gt;33% de las fees = angostar el rango ya no compensa.</i>`,
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

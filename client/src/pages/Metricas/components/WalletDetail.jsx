import { useEffect, useState } from 'react';
import { walletMetricsApi } from '../../../services/api';
import WalletValueChart, { LAYER_COLORS } from './WalletValueChart';
import WalletHoldings from './WalletHoldings';
import { fmtDateTime, fmtUsd } from '../lib/format';
import { ageLabel, sourceLabel } from '../lib/labels';
import styles from '../MetricasPage.module.css';

function StaleNotice({ staleSources }) {
  if (!staleSources?.length) return null;
  return (
    <div className={styles.staleNotice} role="status">
      <strong>Valor parcial.</strong> Estas fuentes no respondieron y se usa su último valor conocido:
      <ul>
        {staleSources.map((s) => (
          <li key={s.key}>{sourceLabel(s.key)} — {ageLabel(s.lastOkAt)}</li>
        ))}
      </ul>
    </div>
  );
}

export default function WalletDetail({ wallet, points, onStatusChange }) {
  const [detail, setDetail] = useState(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(null); // 'refresh' | 'status'
  const [error, setError] = useState(null);
  const capturedAt = wallet.latest?.capturedAt;

  useEffect(() => {
    let cancelled = false;
    setLive(false);
    walletMetricsApi.get(wallet.id)
      .then((data) => { if (!cancelled) setDetail(data?.lastDetail || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Error cargando el detalle'); });
    return () => { cancelled = true; };
  }, [wallet.id, capturedAt]);

  const handleRefresh = async () => {
    setBusy('refresh');
    setError(null);
    try {
      const data = await walletMetricsApi.refresh(wallet.id);
      setDetail(data?.lastDetail || null);
      setLive(true);
    } catch (err) {
      setError(err?.message || 'Error leyendo la wallet');
    } finally {
      setBusy(null);
    }
  };

  const archived = wallet.status === 'archived';
  const handleStatus = async () => {
    setBusy('status');
    setError(null);
    try {
      if (archived) await walletMetricsApi.unarchive(wallet.id);
      else await walletMetricsApi.archive(wallet.id);
      onStatusChange?.();
    } catch (err) {
      setError(err?.message || 'No se pudo cambiar el estado');
      setBusy(null);
    }
  };

  const totals = detail?.totals || wallet.latest?.totals;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardStats}>
          {[
            { label: 'Tokens', value: totals?.tokensUsd, color: LAYER_COLORS.tokens },
            { label: 'LPs', value: totals?.lpUsd, color: LAYER_COLORS.lp },
            { label: 'Hyperliquid', value: totals?.hlUsd, color: LAYER_COLORS.hl },
          ].map((s) => (
            <div key={s.label} className={styles.stat}>
              <span className={styles.statLabel}>{s.label}</span>
              <span className={styles.statValue} style={{ color: s.color }}>{fmtUsd(s.value)}</span>
            </div>
          ))}
        </div>
        <div className={styles.cardActions}>
          {!archived && (
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={handleRefresh}
              disabled={busy != null}
              title="Lee todas las redes ahora; no guarda un punto en la serie"
            >
              {busy === 'refresh' ? '⟳ Leyendo redes…' : '⟳ Refrescar'}
            </button>
          )}
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={handleStatus}
            disabled={busy != null}
            title={archived
              ? 'Retoma la captura horaria con la misma serie'
              : 'Deja de capturar esta wallet; su histórico se conserva'}
          >
            {archived ? 'Reactivar seguimiento' : 'Archivar wallet'}
          </button>
        </div>
      </div>

      <div className={styles.cardMeta}>
        {detail?.capturedAt
          ? `${live ? 'Lectura al momento' : 'Última captura'}: ${fmtDateTime(detail.capturedAt)}`
          : 'Pendiente de la primera captura.'}
        {archived && wallet.archivedAt ? ` · Archivada el ${fmtDateTime(wallet.archivedAt)}` : ''}
      </div>

      {error && <div className={styles.cardError}>Error: {error}</div>}

      <StaleNotice staleSources={detail?.staleSources} />

      <WalletValueChart points={points} />

      <WalletHoldings detail={detail} />
    </div>
  );
}

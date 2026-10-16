import { fmtNum, fmtSigned, toneOf } from '../format';
import styles from './ManualTrading.module.css';

// Franja de griegas y P&L de la cartera de opciones.
export default function GreeksStrip({ account, limits }) {
  const g = account?.greeks || {};
  const maxMargin = Number(limits?.maxMarginUsdt);
  const used = account?.marginUsedUsdt;
  const marginLabel = account
    ? `${fmtNum(used, 0)}${Number.isFinite(maxMargin) && maxMargin > 0 ? ` / ${fmtNum(maxMargin, 0)}` : ''}`
    : '—';

  const balance = account?.balanceUsdt;
  const items = [
    { label: 'Fondos de opciones', value: balance != null && Number.isFinite(Number(balance))
      ? `${fmtNum(Number(balance), 2)} USDT` : '—' },
    { label: 'Delta neto', value: account ? fmtSigned(g.delta, 3) : '—' },
    { label: 'Gamma', value: account ? fmtSigned(g.gamma, 4) : '—' },
    { label: 'Theta / día', value: account ? `${fmtSigned(g.theta, 2)} USDT` : '—', tone: account ? toneOf(g.theta) : 'neutral' },
    { label: 'Vega', value: account ? fmtSigned(g.vega, 2) : '—' },
    {
      label: 'P&L no realizado',
      value: account ? `${fmtSigned(account.unrealizedPnlUsdt, 2)} USDT` : '—',
      tone: account ? toneOf(account.unrealizedPnlUsdt) : 'neutral',
    },
    { label: 'Margen usado', value: marginLabel },
  ];

  return (
    <section aria-label="Griegas de la cartera" className={styles.greeks}>
      {items.map((it) => (
        <div key={it.label} className={styles.greek}>
          <span className={styles.greekLabel}>{it.label}</span>
          <span className={`${styles.mono} ${styles.greekValue} ${styles[it.tone || 'neutral']}`}>{it.value}</span>
        </div>
      ))}
    </section>
  );
}

import { useState } from 'react';
import styles from './OrchestratorWallet.module.css';

function truncate(address) {
  const a = String(address || '');
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Dirección de la wallet dueña del LP, en el encabezado de la tarjeta.
 *
 * Importa que esté a la vista: el LP es de UNA wallet concreta y sólo esa
 * puede firmar. Con varios orquestadores repartidos entre cuentas, saber cuál
 * es sin abrir un modal evita el error de intentar firmar con la conectada
 * equivocada.
 */
export default function OrchestratorWallet({ address }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Sin permiso de portapapeles no hay nada que hacer: la dirección
      // completa ya está en el `title`, así que el usuario puede leerla igual.
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={styles.chip}
      onClick={copy}
      title={`Wallet del LP: ${address}${copied ? '' : ' (clic para copiar)'}`}
      aria-label={`Copiar dirección de la wallet ${address}`}
    >
      <WalletIcon />
      <span className={styles.address}>{truncate(address)}</span>
      <span className={styles.action} aria-hidden="true">{copied ? <CheckIcon /> : <CopyIcon />}</span>
    </button>
  );
}

function WalletIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <path d="M17 12h.01" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

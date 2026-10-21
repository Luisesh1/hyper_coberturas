import { useState } from 'react';
import { useVisibleInterval } from '../strategies/common/useVisibleInterval';
import styles from './ManualTrading.module.css';

// Timestamp exacto publicado por Binance en exchangeInfo; el día visible
// por sí solo no basta para elegir un contrato próximo al vencimiento.
function validMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const pad = (n) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;

function expiryTimeUtc(ms) {
  if (validMs(ms) == null) return null;
  const d = new Date(Number(ms));
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// Hora en la zona del navegador: Binance vence a las 08:00 UTC, que para
// el usuario puede caer de madrugada del día siguiente.
function expiryTimeLocal(ms) {
  if (validMs(ms) == null) return null;
  return new Date(Number(ms)).toLocaleTimeString('es', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  });
}

// La etiqueta de Binance es la fecha UTC; el contrato que vence dentro de
// las próximas 24 h es el "de hoy" sin importar la zona del usuario.
function venceHoy(ms, now) {
  const n = validMs(ms);
  return n != null && n > now && n - now < DAY_MS;
}

// Cuenta regresiva hasta el vencimiento: "12d 04:05:06" o "04:05:06" si
// queda menos de un día. Devuelve null sin timestamp confirmado.
export function formatCountdown(expiryMs, now) {
  const ms = validMs(expiryMs);
  if (ms == null) return null;
  const left = Math.floor((ms - now) / 1000);
  if (left <= 0) return 'vencido';
  const d = Math.floor(left / 86400);
  const hms = `${pad(Math.floor((left % 86400) / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

// Selector de vencimiento: cada botón muestra la cuenta regresiva en vivo;
// la hora exacta (local) solo aparece en el contrato seleccionado.
export default function ExpiryPills({ expiries = [], value, onChange, scroller = false }) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = expiries.some((e) => validMs(e.expiryMs) != null);
  useVisibleInterval(() => setNow(Date.now()), 1000, ticking);
  if (!expiries.length) return null;
  return (
    <div role="group" aria-label="Vencimiento" className={scroller ? styles.expiryScroller : styles.pills}>
      {expiries.map((e) => {
        const on = e.code === value;
        const time = expiryTimeLocal(e.expiryMs);
        const utc = expiryTimeUtc(e.expiryMs);
        const label = venceHoy(e.expiryMs, now) ? 'Hoy' : e.label;
        const countdown = formatCountdown(e.expiryMs, now);
        return (
          <button
            key={e.code}
            type="button"
            className={`${styles.pill} ${on ? styles.pillOn : ''}`}
            aria-pressed={on}
            title={time
              ? `Vence ${e.label} a las ${time}${time.endsWith('UTC') ? '' : ` (${utc})`}`
              : `Vence ${e.label}`}
            onClick={() => onChange(e.code)}
          >
            {label}
            {countdown != null
              ? <span className={`${styles.pillMeta} ${styles.pillCountdown}`}>{countdown}</span>
              : e.dte != null && <span className={styles.pillMeta}>{e.dte}d</span>}
            {on && time && <span className={styles.pillMeta}>{time}</span>}
          </button>
        );
      })}
    </div>
  );
}

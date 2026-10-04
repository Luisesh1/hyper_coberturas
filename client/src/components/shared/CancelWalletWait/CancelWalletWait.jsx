import { useEffect, useState } from 'react';

// Margen para que la wallet muestre la firma antes de ofrecer cortar la espera.
export const CANCEL_WAIT_AFTER_MS = 20_000;

/**
 * La wallet no siempre responde por WalletConnect (SafePal no devuelve ni el
 * hash ni el rechazo). Tras un rato esperando se ofrece dejar de esperar; el
 * envío comprueba antes la cadena por si la tx sí salió.
 */
export default function CancelWalletWait({ awaitingWallet, onCancelWait, resetKey, hintClassName, buttonClassName, wrapperClassName }) {
  const [canCancel, setCanCancel] = useState(false);
  useEffect(() => {
    setCanCancel(false);
    if (!awaitingWallet || !onCancelWait) return undefined;
    const timer = setTimeout(() => setCanCancel(true), CANCEL_WAIT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [awaitingWallet, onCancelWait, resetKey]);

  if (!canCancel) return null;
  return (
    <div className={wrapperClassName}>
      <p className={hintClassName}>
        ¿Ya firmaste o rechazaste y no avanza? La wallet puede no haber respondido.
        Antes de cortar se comprueba si la transacción llegó a la cadena.
      </p>
      <button type="button" className={buttonClassName} onClick={onCancelWait}>
        Cancelar espera
      </button>
    </div>
  );
}

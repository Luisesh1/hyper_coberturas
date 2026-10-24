import { useEffect, useState } from 'react';

// Reloj de pantalla: devuelve Date.now() y lo refresca cada `ms` solo
// mientras `active` (una entrada pendiente con cuenta atrás). Sin `active`
// no hay temporizador y devuelve la hora del render.
export function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  // Sin temporizador, cada render (p. ej. el sondeo de la lista) lee la hora
  // actual: las horas relativas no se congelan en la del montaje.
  return active ? now : Date.now();
}

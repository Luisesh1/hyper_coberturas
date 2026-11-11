import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

// Detalle abierto (bot, estrategia…) guardado en la URL: `?tab=auto&bot=7`.
// - Recargar la página conserva la pantalla en la que se estaba.
// - En el teléfono, abrir el detalle añade una entrada al historial: el gesto
//   o botón «atrás» del sistema vuelve a la lista igual que el botón «Volver».
// Devuelve el id de la URL como texto (o null); se compara con `sameId`.
export function useDetailParam(param, { push = true } = {}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const value = params.get(param);
  const pushedKey = `${param}Pushed`;
  const pushed = !!location.state?.[pushedKey];

  const open = useCallback((id) => {
    const next = new URLSearchParams(params);
    next.set(param, String(id));
    // Ya abierto (cambio de elemento): se reemplaza para no apilar entradas.
    const asPush = push && value === null;
    setParams(next, {
      replace: !asPush,
      state: asPush || pushed ? { ...(location.state || {}), [pushedKey]: true } : location.state,
    });
  }, [params, param, push, value, pushed, pushedKey, setParams, location.state]);

  const close = useCallback(() => {
    if (value === null) return;
    // Si la entrada la añadimos nosotros, se vuelve atrás de verdad: así el
    // historial queda igual que si se hubiera usado el «atrás» del sistema.
    if (pushed) { navigate(-1); return; }
    const next = new URLSearchParams(params);
    next.delete(param);
    setParams(next, { replace: true, state: location.state });
  }, [value, pushed, navigate, params, param, setParams, location.state]);

  // Quita el id sin tocar el historial (p. ej. el elemento ya no existe).
  const clear = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(param);
      return next;
    }, { replace: true });
  }, [param, setParams]);

  return { value, open, close, clear };
}

export const sameId = (id, value) => value !== null && value !== undefined && String(id) === String(value);

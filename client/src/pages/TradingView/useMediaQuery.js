import { useEffect, useState } from 'react';

// Breakpoint compartido con los @media (max-width: 768px) del módulo.
export const MOBILE_QUERY = '(max-width: 768px)';

function matches(query) {
  try {
    return typeof window !== 'undefined' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query) {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    let mql;
    try { mql = window.matchMedia(query); } catch { return undefined; }
    const onChange = () => setValue(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [query]);
  return value;
}

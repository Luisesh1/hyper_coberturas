/**
 * Cambio en el rango por wallet y agregado de todas.
 *
 * El agregado es la SUMA DE LOS CAMBIOS de cada wallet, no "total hoy menos
 * total al inicio": una wallet que empieza a seguirse a mitad de rango aporta
 * desde su primer punto, y una archivada conserva el cambio que tuvo hasta su
 * ultimo punto. Asi ninguna entrada o salida de wallet parece ganancia.
 */

const HOUR_MS = 3_600_000;

function hourOf(t) {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/** @param {{t: number, total: number}[]} points ordenados por tiempo */
export function walletChange(points) {
  if (!points?.length) return null;
  const firstUsd = points[0].total;
  const lastUsd = points[points.length - 1].total;
  const changeUsd = lastUsd - firstUsd;
  return {
    firstUsd,
    lastUsd,
    changeUsd,
    changePct: firstUsd > 0 ? (changeUsd / firstUsd) * 100 : null,
  };
}

/**
 * @param {Record<string, {t: number, total: number}[]>} seriesById
 * @returns {{changeUsd, basisUsd, changePct, curve: {t, value}[]}}
 *   `curve` es el cambio acumulado por hora (empieza en 0).
 */
export function aggregateChange(seriesById) {
  const series = Object.values(seriesById || {}).filter((pts) => pts?.length);
  if (!series.length) return { changeUsd: null, basisUsd: null, changePct: null, curve: [] };

  let changeUsd = 0;
  let basisUsd = 0;
  for (const pts of series) {
    const c = walletChange(pts);
    changeUsd += c.changeUsd;
    basisUsd += c.firstUsd;
  }

  // Ultimo valor de cada wallet en cada hora.
  const hourly = series.map((pts) => {
    const byHour = new Map();
    for (const pt of pts) byHour.set(hourOf(pt.t), pt.total);
    return { first: pts[0].total, byHour };
  });
  const hours = [...new Set(hourly.flatMap((w) => [...w.byHour.keys()]))].sort((a, b) => a - b);

  const lastSeen = hourly.map(() => null);
  const curve = hours.map((h) => {
    let value = 0;
    hourly.forEach((w, i) => {
      if (w.byHour.has(h)) lastSeen[i] = w.byHour.get(h);
      if (lastSeen[i] != null) value += lastSeen[i] - w.first;
    });
    return { t: h, value: Math.round(value * 100) / 100 };
  });

  return {
    changeUsd: Math.round(changeUsd * 100) / 100,
    basisUsd,
    changePct: basisUsd > 0 ? (changeUsd / basisUsd) * 100 : null,
    curve,
  };
}

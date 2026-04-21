// Catálogo de herramientas de dibujo para el overlay del chart.
// Los trazos persistentes usan `type`; `ruler` existe como herramienta pero
// NO se persiste (es una medición efímera).

export const TOOLS = {
  select: {
    id: 'select',
    label: 'Seleccionar',
    icon: '↖',
    cursor: 'default',
    persistent: false,
  },
  ruler: {
    id: 'ruler',
    label: 'Regla / medición',
    icon: '📏',
    cursor: 'crosshair',
    persistent: false,
    anchors: 2,
  },
  trendline: {
    id: 'trendline',
    label: 'Línea de tendencia',
    icon: '╱',
    cursor: 'crosshair',
    persistent: true,
    anchors: 2,
    defaultStyle: { color: '#60a5fa', lineWidth: 2, lineStyle: 'solid' },
  },
  horizontal: {
    id: 'horizontal',
    label: 'Línea horizontal',
    icon: '─',
    cursor: 'crosshair',
    persistent: true,
    anchors: 1,
    defaultStyle: { color: '#facc15', lineWidth: 1, lineStyle: 'solid' },
  },
  rectangle: {
    id: 'rectangle',
    label: 'Rectángulo / zona',
    icon: '▭',
    cursor: 'crosshair',
    persistent: true,
    anchors: 2,
    defaultStyle: { color: '#a855f7', lineWidth: 1, lineStyle: 'solid', fillOpacity: 0.15 },
  },
  fib: {
    id: 'fib',
    label: 'Fibonacci retracement',
    icon: '𝜑',
    cursor: 'crosshair',
    persistent: true,
    anchors: 2,
    defaultStyle: { color: '#14b8a6', lineWidth: 1, lineStyle: 'solid' },
  },
};

export const FIB_LEVELS = [
  { level: 0,     color: '#94a3b8' },
  { level: 0.236, color: '#f97316' },
  { level: 0.382, color: '#fbbf24' },
  { level: 0.5,   color: '#a3e635' },
  { level: 0.618, color: '#22d3ee' },
  { level: 0.786, color: '#818cf8' },
  { level: 1,     color: '#94a3b8' },
];

export function newDrawing(type) {
  const meta = TOOLS[type];
  if (!meta || !meta.persistent) return null;
  return {
    uid: `${type}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    anchors: [],
    style: { ...(meta.defaultStyle || {}) },
    visible: true,
  };
}

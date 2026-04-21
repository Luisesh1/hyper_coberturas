// Detección de click sobre un dibujo (± tolerancia en px).
// `project` convierte { time, price } → { x, y }.

const TOLERANCE = 5;

function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const sx = x1 + t * dx;
  const sy = y1 + t * dy;
  return Math.hypot(px - sx, py - sy);
}

function pointInRect(px, py, x1, y1, x2, y2) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

function nearRectBorder(px, py, x1, y1, x2, y2, tol = TOLERANCE) {
  // Distancia a cada arista (4 líneas)
  const d = Math.min(
    distPointToSegment(px, py, x1, y1, x2, y1),
    distPointToSegment(px, py, x2, y1, x2, y2),
    distPointToSegment(px, py, x2, y2, x1, y2),
    distPointToSegment(px, py, x1, y2, x1, y1),
  );
  return d <= tol;
}

export function hitTestDrawing(drawing, px, py, project, width) {
  if (!drawing || drawing.visible === false) return false;

  switch (drawing.type) {
    case 'trendline': {
      const [a, b] = drawing.anchors;
      const pa = project(a);
      const pb = project(b);
      if (!pa || !pb) return false;
      return distPointToSegment(px, py, pa.x, pa.y, pb.x, pb.y) <= TOLERANCE;
    }
    case 'horizontal': {
      const p = project(drawing.anchors[0]);
      if (!p) return false;
      return Math.abs(py - p.y) <= TOLERANCE && px >= 0 && px <= (width || Infinity);
    }
    case 'rectangle': {
      const [a, b] = drawing.anchors;
      const pa = project(a);
      const pb = project(b);
      if (!pa || !pb) return false;
      // Hit en borde o en interior (ambos seleccionan)
      if (nearRectBorder(px, py, pa.x, pa.y, pb.x, pb.y)) return true;
      return pointInRect(px, py, pa.x, pa.y, pb.x, pb.y);
    }
    case 'fib': {
      const [a, b] = drawing.anchors;
      const pa = project(a);
      const pb = project(b);
      if (!pa || !pb) return false;
      // Hit en cualquiera de los dos anchors (handles) o en la diagonal
      if (Math.hypot(px - pa.x, py - pa.y) <= TOLERANCE + 2) return true;
      if (Math.hypot(px - pb.x, py - pb.y) <= TOLERANCE + 2) return true;
      return distPointToSegment(px, py, pa.x, pa.y, pb.x, pb.y) <= TOLERANCE;
    }
    default:
      return false;
  }
}

export function findHitDrawing(drawings, px, py, project, width) {
  // Iterar de atrás hacia adelante (topmost primero)
  for (let i = drawings.length - 1; i >= 0; i -= 1) {
    if (hitTestDrawing(drawings[i], px, py, project, width)) {
      return drawings[i];
    }
  }
  return null;
}

export { distPointToSegment, pointInRect };

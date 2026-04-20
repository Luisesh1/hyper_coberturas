import styles from './Skeleton.module.css';

/**
 * Skeleton — placeholder animado mientras se carga contenido asíncrono.
 *
 * Variantes:
 *   - variant="line"  (default) — una línea de texto
 *   - variant="card"  — bloque card completo
 *   - variant="circle" — avatar/ícono
 *
 * `count` repite el skeleton (útil para listas).
 */
export function Skeleton({
  variant = 'line',
  width,
  height,
  count = 1,
  className = '',
}) {
  const style = {};
  if (width != null) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height != null) style.height = typeof height === 'number' ? `${height}px` : height;

  const items = [];
  for (let i = 0; i < Math.max(1, Number(count) || 1); i += 1) {
    items.push(
      <span
        key={i}
        className={`${styles.base} ${styles[variant] || ''} ${className}`.trim()}
        style={style}
        role="status"
        aria-label="Cargando…"
      />,
    );
  }
  return count > 1 ? <span className={styles.group}>{items}</span> : items[0];
}

/**
 * SkeletonCardList — renderiza N tarjetas-skeleton para listas tipo card.
 */
export function SkeletonCardList({ count = 3, height = 120 }) {
  return (
    <div className={styles.list}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} variant="card" height={height} />
      ))}
    </div>
  );
}

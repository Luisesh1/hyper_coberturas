import styles from './Spinner.module.css';

export function Spinner({ size = 16, color = 'currentColor', className = '' }) {
  return (
    <span
      className={`${styles.spinner} ${className}`}
      style={{ width: size, height: size, borderColor: `${color}33`, borderTopColor: color }}
    />
  );
}

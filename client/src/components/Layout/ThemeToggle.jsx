/**
 * ThemeToggle — interruptor de apariencia clara/oscura.
 *
 * Se expone como `role="switch"` (no como botón suelto) porque representa un
 * estado on/off persistente: los lectores de pantalla anuncian "activado /
 * desactivado" y el usuario sabe qué tema está puesto sin ver el icono.
 * El icono es decorativo (`aria-hidden`); el nombre accesible sale del
 * `aria-label`, que describe la ACCIÓN ("Activar modo claro").
 */
import { useTheme } from '../../context/ThemeContext';
import styles from './ThemeToggle.module.css';

export function ThemeToggle({ showLabel = false, className = '' }) {
  const { isLight, toggleTheme } = useTheme();

  // El label describe a qué tema se cambiaría al pulsar.
  const targetLabel = isLight ? 'Modo oscuro' : 'Modo claro';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isLight}
      aria-label={`Activar ${targetLabel.toLowerCase()}`}
      title={`Activar ${targetLabel.toLowerCase()}`}
      className={`${styles.toggle} ${showLabel ? styles.withLabel : ''} ${className}`.trim()}
      onClick={toggleTheme}
    >
      <span className={styles.icon} aria-hidden="true">{isLight ? '☾' : '☀'}</span>
      {showLabel && <span className={styles.label}>{targetLabel}</span>}
    </button>
  );
}

export default ThemeToggle;

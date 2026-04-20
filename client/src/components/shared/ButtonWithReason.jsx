import styles from './ButtonWithReason.module.css';

/**
 * ButtonWithReason — botón que cuando está deshabilitado muestra un tooltip
 * explicando la razón (`disabledReason`). Evita el anti-pattern de botón
 * gris sin contexto que el usuario no entiende.
 *
 * Si `disabledReason` está presente, el botón queda disabled sin importar
 * `disabled`. Si solo llega `disabled`, se comporta como <button> nativo.
 */
export function ButtonWithReason({
  children,
  disabled = false,
  disabledReason = null,
  className = '',
  type = 'button',
  onClick,
  ...rest
}) {
  const isDisabled = Boolean(disabled || disabledReason);
  return (
    <span
      className={styles.wrapper}
      title={isDisabled && disabledReason ? disabledReason : undefined}
      data-disabled={isDisabled ? 'true' : undefined}
    >
      <button
        type={type}
        disabled={isDisabled}
        onClick={isDisabled ? undefined : onClick}
        className={`${className} ${isDisabled ? styles.disabled : ''}`.trim()}
        aria-disabled={isDisabled || undefined}
        {...rest}
      >
        {children}
      </button>
      {isDisabled && disabledReason && (
        <span className={styles.visuallyHidden}>{disabledReason}</span>
      )}
    </span>
  );
}

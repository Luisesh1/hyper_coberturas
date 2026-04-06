# ADR 0002: Contratos HTTP compatibles durante la migración

## Estado
Aprobado

## Contexto
La API actual mezcla respuestas exitosas y errores con formatos distintos. El frontend consume campos legacy como `success`, `error`, `code` y `requestId`.

## Decisión
Durante la migración se adopta un envelope estable compatible hacia atrás:

### Éxito
- `success: true`
- `data`
- `meta` opcional

### Error
- `success: false`
- `error`: mensaje legacy
- `code`: código legacy
- `errorInfo`: objeto normalizado con `code`, `message`, `details`, `requestId`
- `requestId`, `details` y `stack` se mantienen mientras existan consumidores legacy

El cliente HTTP debe aceptar ambos formatos sin exigir cambios masivos inmediatos en pantallas existentes.

## Consecuencias
- Podemos introducir contratos más claros sin romper el frontend actual.
- Nuevas rutas y módulos deben preferir el envelope compartido en vez de construir JSON ad hoc.
- La limpieza total de campos legacy queda para una fase posterior, cuando el frontend deje de depender de ellos.

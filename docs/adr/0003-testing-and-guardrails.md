# ADR 0003: Estrategia de testing y guardrails de arquitectura

## Estado
Aprobado

## Contexto
El proyecto necesita refactorizar hotspots críticos sin congelar desarrollo. Sin guardrails, el código nuevo puede volver a concentrarse en archivos gigantes o violar límites de capas.

## Decisión
Se establecen tres niveles de validación:

- Unit tests sobre lógica pura de dominio y helpers compartidos.
- Integration tests sobre rutas y casos de uso críticos.
- UI tests para flujos sensibles de wallet, LP y protección.

Además, el workspace tendrá checks automáticos mínimos:

- `check:hotspots`: falla si archivos críticos superan umbrales de tamaño definidos.
- `check:architecture`: falla si módulos de dominio importan capas prohibidas o si `shared` depende de dominios.

## Consecuencias
- La refactorización se vuelve medible y no solo aspiracional.
- Los hotspots existentes quedan explicitados como deuda a bajar gradualmente.
- Los nuevos módulos tendrán límites más claros desde su nacimiento.

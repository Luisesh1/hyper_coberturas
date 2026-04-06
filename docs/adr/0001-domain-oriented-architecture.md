# ADR 0001: Arquitectura orientada a dominios e incremental

## Estado
Aprobado

## Contexto
El proyecto creció alrededor de servicios y componentes monolíticos. Eso elevó el acoplamiento, duplicó reglas de negocio y volvió frágiles varios flujos LP, protección y wallet.

## Decisión
La refactorización se hará de forma incremental, manteniendo Express, React y JavaScript. La organización objetivo pasa a ser por dominio y por capas:

- `domain`: reglas puras y cálculos testeables.
- `application`: casos de uso y orquestación.
- `infrastructure`: SDKs, repositorios, proveedores externos.
- `interface`: rutas, schemas y mappers de entrada/salida.

En frontend, la organización objetivo será por feature slice:

- `features/<feature>/api`
- `features/<feature>/hooks`
- `features/<feature>/components`
- `features/<feature>/view-model`
- `shared/*`

## Consecuencias
- Se reduce el tamaño y la responsabilidad de archivos hotspot.
- La migración debe preservar endpoints y flujos actuales mediante wrappers.
- Nuevas reglas de negocio deben salir de `services/` y modales grandes hacia módulos puros o hooks dedicados.
- Los cambios de arquitectura se validarán con guardrails automáticos y ADRs cortos.

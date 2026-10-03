# Reintento del asistente de LP orquestado — diseño

Fecha: 2026-10-03. Base: `origin/main` @ `e3f95c8`.

## Contexto

La primera creación real en Robinhood (LP #3571232) falló tres veces en puntos
distintos y en cada uno el asistente obligó a empezar de cero:

- A mitad de las transacciones, la wallet no devolvió el hash (ya resuelto en
  `f6db96a`: rescate por nonce). Para reanudar hubo que recargar y volver a
  configurar todo.
- Tras el mint, la cobertura falló (USDG no se valoraba; resuelto en `670035b`).
  «Reintentar la cobertura» llama a `resetOutcome`, que borra el resultado y deja
  el asistente en un paso sin contenido. El LP quedó sin cubrir hasta añadir
  `POST /lp-orchestrators/retry-commit` (`e3f95c8`) y lanzarlo a mano.
- Al reiniciar se conservan pool, rango y slippage, pero la cobertura vuelve a
  los valores por defecto (`resetProtection` en `handleReset`): la política pasa
  a «Zonas legacy».

## Decisiones acordadas

| Tema | Decisión |
|---|---|
| Fallo a mitad de las transacciones | **Recalcular desde la cadena.** Se conserva la configuración; fondeo y `prepare` se rehacen con saldos y permisos actuales y se va directo a Revisión. Lo ya minado no se repite porque el plan nuevo no lo necesita. No se reanuda el plan viejo: sus cotizaciones, mínimos y deadline pueden haber caducado. |
| Fallo después del mint | «Reintentar la cobertura» **vuelve al paso de Cobertura con la configuración cargada**. El usuario puede cambiar cuenta, leverage, política o notional, pasa la verificación previa y confirma; se llama a `retry-commit` con esa configuración. Sin firmas. |
| Reiniciar desde cero | Se conserva **toda** la configuración **salvo el capital**, que se recalcula con el saldo actual. |
| Fallo antes de firmar | Sin cambios: el usuario ya permanece en el paso con el error. |

## Cliente (`client/src/features/lp-wizard`)

### Estado: qué es configuración y qué depende de la cadena

- **Configuración** (sobrevive a cualquier reintento o reinicio): red, versión,
  pool dinámico existente o hook verificado, tokens, fee, nombre (y si fue
  editado), modo y preset de rango, precios y peso personalizados, slippage y
  todo `protection` (cuenta, política, leverage, preset, notional manual,
  avanzado). El capital se conserva en los reintentos, no en el reinicio.
- **Dependiente de la cadena** (se descarta y se recalcula): `availableAssets`,
  `assetSelections`, `importedFundingTokens`, `fundingPlan`, `fundingIssue`,
  `prepareData`, hashes y estado de ejecución, intención (`intentRef`) y
  verificación previa (`preflight`, `protectionDone`).

### Acciones de `useUnifiedLpFlow`

- `handleReset` (reiniciar desde cero): deja de llamar a `resetProtection`.
  Descarta lo dependiente de la cadena, vuelve al paso Pool y recalcula el
  capital con el saldo (el mismo cálculo que ya precarga el valor al elegir red).
  El notional automático solo se recalcula si `protectionDirtyRef` es falso.
- `retryFromChain` (nuevo; fallo a mitad de transacciones): descarta lo
  dependiente de la cadena y la intención, conserva configuración **y capital**,
  relanza la carga de activos → plan de fondeo → `prepare` y deja al usuario en
  Revisión. Si el recálculo falla, queda en el paso Fondeo con el error.
  `StepError` usa esta acción en lugar de `unified.handleReset` cuando hubo al
  menos una transacción enviada; sin transacciones enviadas mantiene el reinicio.
- `enterProtectionRetry` (nuevo; fallo después del mint): conserva el
  `operationKey` de la operación compensada (hoy `resetOutcome` lo borra), cierra
  el resultado y abre el paso Cobertura en modo reintento. En ese modo la
  verificación previa funciona igual y el botón final llama a
  `lpOrchestratorApi.retryCommit(operationKey, protectionPayload)`; su respuesta
  vuelve a mostrarse con `StepOutcome` (completado o compensado otra vez).
  `resetOutcome` se elimina.

## Servidor

- `POST /lp-orchestrators/retry-commit` acepta `{ operationKey, protection? }`.
  `protection` se valida con `wizardProtectionSchema`.
- `LpCreateSaga.retryCommit({ userId, operationKey, protection })`:
  1. Mismas comprobaciones que hoy (existe, `compensated`, LP superviviente).
  2. Si llega `protection`, construye el plan nuevo `{ ...operation.plan, protection }`
     y vuelve a aplicar la regla hook/política de `beginIntent` (un hook con
     retornos de delta en swaps solo admite `terminal_range_v1` o
     `range_exit_v1`). Se extrae esa regla a una función compartida.
  3. `reopenCompensated` guarda también el plan nuevo, de forma atómica, para que
     el worker reanude con la misma configuración si el proceso muere.
  4. Delega en `commitIntent` como ahora.

## Errores y casos límite

- Reintento concurrente o doble clic: `reopenCompensated` es atómico; el segundo
  recibe 409 `OPERATION_IN_PROGRESS` y el cliente muestra el estado actual.
- LP cerrado entre el fallo y el reintento: la carga del snapshot falla, la saga
  compensa de nuevo y `StepOutcome` lo muestra; no se abre hedge.
- Fallo a mitad de transacciones sin ninguna minada (rechazo en la primera
  firma): `retryFromChain` produce el mismo plan; es equivalente a volver a
  Revisión.
- Intenciones huérfanas: la intención abandonada en `retryFromChain` no tiene
  hashes guardados, así que `expireStaleIntents` la caduca como hoy.

## Tests

- Cliente (`useUnifiedLpFlow.test.jsx`, `StepError`/`StepOutcome`):
  `handleReset` conserva cobertura y recalcula capital; `retryFromChain` conserva
  configuración y capital y termina en Revisión; `enterProtectionRetry` abre
  Cobertura con la configuración y llama a `retryCommit` con el payload editado.
- Servidor (`lp-orchestrator-create-saga.test.js`): `retryCommit` con
  `protection` guarda el plan nuevo y lo usa; rechaza una política incompatible
  con el hook; sin `protection` mantiene el plan.
- E2E: solo si ya existe un spec del asistente al que añadirlo, contra Docker en
  `localhost:5174`.

## Fuera de alcance

«Total disponible $0» en el fondeo, refresco de la lista de cuentas de
Hyperliquid tras añadir una en otra pestaña y el token de Telegram compartido
entre desarrollo y producción.

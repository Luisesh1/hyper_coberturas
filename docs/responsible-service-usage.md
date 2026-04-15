# Uso responsable de APIs y servicios

## Objetivo

Reducir riesgos de `429`, bloqueos por abuso y comportamiento agresivo frente a
proveedores externos usados por este proyecto.

## Servicios revisados

- Hyperliquid
  - Docs API: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
  - Referencia de límites/weights: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
  - Notas de websocket: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- Telegram Bot API
  - Bot API: https://core.telegram.org/bots/api
  - `ResponseParameters.retry_after`: misma referencia en la sección `ResponseParameters`
- Etherscan
  - Best practices: https://docs.etherscan.io/resources/best-practices
  - Rate limits: https://docs.etherscan.io/resources/rate-limits
- Alchemy
  - Error reference: https://www.alchemy.com/docs/reference/error-reference
  - Throughput: https://www.alchemy.com/docs/reference/throughput
  - Terms: https://www.alchemy.com/terms-conditions/terms
- Reown / WalletConnect
  - Terms: https://reown.com/terms-of-service

## Ajustes aplicados

### Telegram

- Cola secuencial por instancia para evitar ráfagas de mensajes.
- Respeto explícito de `retry_after` cuando Telegram devuelve `429`.
- Reintentos con backoff sólo para errores transitorios o de flood control.
- El servicio de comandos también reutiliza esta lógica en `getUpdates` y
  `setMyCommands`.

### Hyperliquid

- Los reintentos se limitan a lecturas del endpoint `/info`.
- No se reintentan acciones del endpoint `/exchange` para evitar duplicar
  órdenes o efectos no idempotentes.
- Las lecturas retryables usan backoff corto y registro de observabilidad.

### Alchemy

- Cola global con concurrencia baja y separación mínima entre requests.
- Backoff ante `429` o errores de throughput / concurrencia.
- Cache de metadata de tokens para evitar solicitudes repetidas a
  `alchemy_getTokenMetadata`.

### Etherscan

- Se mantuvo la cola existente con `3 req/s` como valor por defecto, alineado
  con el plan gratuito y con las recomendaciones de uso responsable.
- El límite ahora queda centralizado en `config`.

### Reown / WalletConnect

- No se añadieron llamadas directas nuevas.
- El cliente ya opera a través del SDK oficial; la mitigación principal aquí es
  evitar reconexiones o polling redundante desde la aplicación.

## Variables de entorno relevantes

- `HL_INFO_RETRY_MAX_ATTEMPTS`
- `HL_INFO_RETRY_BASE_MS`
- `TELEGRAM_SEND_MIN_INTERVAL_MS`
- `TELEGRAM_RETRY_MAX_ATTEMPTS`
- `ALCHEMY_MAX_CONCURRENT_REQUESTS`
- `ALCHEMY_MIN_INTERVAL_MS`
- `ALCHEMY_RETRY_MAX_ATTEMPTS`
- `ALCHEMY_METADATA_CACHE_TTL_MS`
- `ETHERSCAN_MAX_REQUESTS_PER_SECOND`

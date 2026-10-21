# Métricas por wallet — diseño

Fecha: 2026-10-20 · Estado: borrador para aprobación

## Intención

Hoy Métricas guarda una foto horaria **por orquestador activo**: tokens de la
wallet en la red del orquestador, el LP orquestado y la cuenta de Hyperliquid
vinculada. Cuando el orquestador se cierra o se archiva, su serie se corta. El
orquestador mata y recrea LPs, y el capital sigue en la wallet después de
cerrarlo. Por eso esa serie no responde a la pregunta que importa al usuario:
**¿cuánto vale en total lo que tengo en esta wallet y cómo cambia?**

El cambio: Métricas pasa a medir **wallets**. Se sigue toda wallet con la que
se haya creado algún orquestador, y el seguimiento continúa después de cerrar
sus orquestadores hasta que el usuario **archive la wallet de forma explícita**.

## Objetivos

1. Una serie horaria por wallet con el **valor total bruto en USD** de:
   - **Tokens:** nativo + ERC-20 de la wallet en **todas** las redes de
     `SUPPORTED_NETWORKS` que no son testnet
     (`server/src/services/uniswap/networks.js`: ethereum, arbitrum, robinhood,
     base, optimism, polygon).
   - **LPs:** **todas** las posiciones Uniswap (v3 y v4) de la wallet en esas
     redes, estén orquestadas o no. Valor = valor actual de la posición + fees
     sin cobrar.
   - **Hyperliquid:** saldo de la **misma dirección** que la wallet, leído por la
     API pública `info` (`clearinghouseState` + `spotClearinghouseState`). No
     hace falta que la dirección esté registrada como cuenta en la app ni que
     haya clave. Cuenta perps (accountValue) **y** spot.
2. **Alta automática:**
   - Al desplegar, entra en seguimiento toda wallet distinta
     (`lp_orchestrators.wallet_address` en minúsculas, por usuario) que tenga
     algún orquestador, **incluidos los archivados**.
   - Al crear un orquestador con una wallet que aún no se sigue (también por
     adopción o `retry-commit`), la wallet entra en seguimiento.
   - Si la wallet estaba archivada, se **reactiva** sola.
3. **Archivar / reactivar a mano** desde Métricas. Archivar detiene la captura y
   oculta la wallet de la vista principal, aunque sigue accesible en «Archivadas».
   Reactivar retoma la misma serie, con un hueco en el periodo archivado.
4. **Página Métricas** (`/metricas`), rehecha:
   - Arriba: total de todas las wallets activas y su variación (USD y %) en el
     rango elegido.
   - Selector de rango: 24h / 7d / 30d / todo.
   - Por wallet: dirección (abreviada y copiable), total actual, variación del
     periodo, **gráfica del total** y **desglose apilado** (tokens / LPs / HL).
   - **Detalle actual** de cada wallet: cada token (red, símbolo, cantidad, USD),
     cada LP (red, versión, par, tokenId, rango, valor + fees) y la cuenta HL
     (perps, spot y total).
   - Debe verse bien en móvil (390 px), con un layout pensado para teléfono.
     Es preferencia permanente del usuario.
5. **Fallos parciales:** si una fuente falla en una captura (RPC de una red,
   escaneo de LPs o Hyperliquid), esa parte reutiliza su **último valor
   conocido** y el punto se marca como **parcial**, con la lista de las fuentes
   afectadas. La gráfica no debe caer en falso. La UI distingue los puntos
   parciales en el tooltip y con un aviso discreto en la wallet si el último
   punto es parcial.

6. **Último valor conocido sin límite de antigüedad.** Una fuente es un par
   red × tipo (`tokens:arbitrum`, `lps:polygon`…) o `hl`. Una fuente caída
   reusa su último valor durante el tiempo que haga falta. El snapshot guarda en
   `stale_sources` cada fuente reusada junto con la fecha de su último dato
   bueno, y la UI muestra esa antigüedad («LPs en polygon: dato de hace 3 d»).
   Si una fuente **nunca** respondió, cuenta 0 y el punto queda marcado como
   parcial.
7. **LP con un token sin precio:** el token se valora con el **precio del
   propio pool** (tick/sqrtPrice) frente al otro lado si ese lado tiene precio
   (WETH, nativo o estable). Si ningún lado tiene precio, el LP se trata como
   fuente caída para ese LP y se reusa su último valor.
8. **Total global y su cambio = suma de los cambios de cada wallet** en el
   rango. Una wallet que entra a mitad de rango aporta desde su primer punto, y
   una que se archiva aporta hasta su último punto. Ninguna de las dos aparece
   como ganancia o pérdida. La gráfica global, si se muestra, sigue la misma
   regla. «Todo» empieza en el punto más antiguo de cualquier wallet.

## No-objetivos

- **No** se ajusta por depósitos ni retiros: es valor bruto, y entradas y
  salidas de capital se verán como saltos. No hay anotaciones manuales de flujos.
- **No** se importa el histórico de `orchestrator_metric_snapshots` (o como se
  llame la tabla actual): la serie por wallet empieza con el despliegue. La
  tabla vieja **se conserva en la base**, sin borrarla ni migrarla.
- **No** se siguen wallets que nunca tuvieron orquestador, ni se pueden añadir
  wallets a mano. Decisión del usuario: el alta viene de crear orquestadores.
- **No** hay cuentas HL vinculadas a mano ni HL de otra dirección.

## Se elimina de Métricas

Lo reemplaza todo lo anterior. Sale de la página Métricas: PnL contable por
orquestador, selector de políticas shadow (`policySnapshot`), tracking del hedge
y filas por orquestador (`OrchestratorRow`, `OrchestratorMetricChart`,
`MetricsFilterBar`, `PortfolioStrip` en su forma actual, `useSnapshotSeries` y
`lib/policySnapshot`). En el servidor se retiran la captura horaria por
orquestador (`orchestrator-metrics.service.js`, su `start()` en
`bootstrap/infra.js`) y las rutas `orchestrator-metrics.routes.js`, **salvo que
otra parte de la app las use**. El builder debe comprobarlo con grep antes de
borrar nada. `ShadowPolicyCard` en `ProtectedPoolCard` **no** forma parte de
Métricas y se queda.

## Anti-objetivos (sería un fracaso aunque funcione)

- Caídas o picos falsos en la gráfica por un RPC caído o un precio que falta.
- Que cerrar o archivar un orquestador corte la serie de su wallet.
- Doble conteo: el mismo valor sumado dos veces (por ejemplo, USDC de HL en
  perps y spot a la vez si la cuenta es unificada, o un LP contado también como
  token).
- Borrar datos existentes (tabla vieja, snapshots) sin backup y confirmación.
- Saturar el presupuesto de peso de Hyperliquid (`hl-weight-budget.service.js`)
  o los RPC de Alchemy y bloquear los orquestadores en vivo.

## Restricciones

- Stack existente: Express + Postgres en `server/`, React + Vite en `client/`,
  migraciones SQL en `server/src/db/migrations/` (la siguiente es la `041_…`).
- Multiusuario: cada wallet seguida pertenece a un `user_id`. Las rutas
  autentican y filtran por usuario, igual que las actuales. La misma dirección
  bajo dos usuarios son dos filas independientes.
- Frecuencia: **una captura por hora**, como ahora.
- Tests e2e con Playwright contra Docker en `localhost:5174`.

## Piezas reutilizables (verificadas en el código)

- Redes: `SUPPORTED_NETWORKS` en `server/src/services/uniswap/networks.js`.
- Tokens: `wallet-balance.service.js#getAllTokenBalancesUsd(wallet, { network })`.
  **Ojo:** valora el nativo como `ETH` con los mids de HL. En polygon el nativo
  es POL, así que hay que usar el `nativeSymbol` de la red. Además
  `cross-chain/multichain-balances.js` ya lee balances en varias redes con
  timeout por red, y puede servir de base.
- LPs: `uniswap.service.js#scanV3PositionsByWallet` / `scanV4PositionsByWallet`
  (`{ userId, wallet, networkConfig }`).
- HL: `hyperliquid.service.js#getClearinghouseState(address)`. Hay que añadir
  la lectura `spotClearinghouseState` si no existe.

## Decidido por el usuario

LPs = todos los de la wallet · HL = misma dirección, leída en público, perps +
spot · redes = todas las soportadas · lo de orquestador se elimina de Métricas ·
valor bruto sin ajuste por flujos · alta de todas las wallets ya usadas · sin
importar histórico · archivar reversible · captura horaria · ante fallos se
reusa el último valor y el punto se marca como parcial · la vista incluye
gráfica del total, desglose apilado, detalle actual y cambio del periodo ·
último valor sin límite de antigüedad, con aviso · LP sin precio valorado con
el precio del propio pool · total global = suma de los cambios por wallet.

## Decisiones mías (revisables)

- **Modelo de datos:** tabla `tracked_wallets` (`id`, `user_id`, `address` en
  minúsculas, `label` opcional, `status` active|archived, `archived_at`,
  `created_at`, único `(user_id, address)`) y `wallet_value_snapshots`
  (`tracked_wallet_id`, `captured_at`, `total_usd`, `tokens_usd`, `lp_usd`,
  `hl_usd`, `is_partial`, `stale_sources` jsonb, `detail` jsonb con el desglose
  por token, LP y HL). El detalle se guarda en cada snapshot para que el
  «detalle actual» salga de la última foto sin recalcular. Si pesa demasiado, el
  builder puede guardar el detalle solo en la última fila.
- **«Detalle actual»** se sirve desde el último snapshot, más un endpoint
  `refresh` opcional que recalcula al momento sin persistir, como el
  `/:id/current` actual.
- **Tokens sin precio** no suman y se listan aparte como «sin precio»; no
  cuentan como fallo parcial.
- **Polvo:** se ocultan en el detalle los tokens por debajo de $1, pero cuentan
  en el total.
- **HL unificada:** si spot ya está incluido en `accountValue` (cuenta
  unificada), se cuenta una sola vez. El builder debe verificarlo contra la
  respuesta real de la API.
- **Testnets fuera:** se excluyen las redes con `isTestnet` (p. ej.
  `base-sepolia`), porque su ETH se valoraría al precio real.
- **HL perps = `accountValue`**, incluido el PnL abierto del hedge, porque es el
  valor real de la cuenta. El spot que no sea USDC se valora con los mids spot
  de HL, en **una sola llamada por captura** compartida por todas las wallets,
  y respetando `hl-weight-budget`.
- **Escaneo compartido por dirección:** si dos usuarios siguen la misma
  dirección, se escanea una vez por captura y el resultado se reparte. La clave
  de Etherscan es la del primer usuario activo que la tenga.
- **LPs con liquidez 0** (cerrados pero sin quemar) no se muestran ni suman;
  solo suman sus fees sin cobrar, si quedan.
- **Captura escalonada:** wallets en serie y redes en paralelo con timeout por
  red, para no hacer ráfagas contra Alchemy y HL.

## Lo que queda al builder

Nombres de archivos, rutas y componentes; librería de gráficas (reutilizar la
que ya usa Métricas); forma exacta de los endpoints; cómo se distribuye el
escaneo de LPs en el tiempo; diseño visual dentro de las convenciones de la app.

## Notas de implementación (2026-10-20)

- `last_detail` vive en `tracked_wallets` (se sobrescribe en cada captura); los
  snapshots solo guardan totales, `is_partial` y `stale_sources`. Así la serie
  no crece con el desglose por token.
- Alta y reactivación por SQL idempotente (`syncFromOrchestrators`) antes de cada
  captura y al listar, en vez de enganchar los flujos de creación/adopción.
- `wallet-balance.service`: reporta `errors` (en vez de tragarlos), usa el
  `nativeSymbol` de la red (POL en Polygon) y, si el RPC principal falla por
  HTTP (p. ej. 403 porque la app de Alchemy no tiene esa red), reintenta en el
  RPC público; un 401/403 desvía la red al público 10 min.
- Escaneo de LPs en modo `lightweight` (sin historial NFT, valoración histórica ni
  anotaciones), con `failedIdentifiers`: una posición ilegible marca la fuente
  como caída en vez de desaparecer del total.
- v4 sin indexador (Etherscan gratis y Alchemy NFT rechazan robinhood/optimism):
  se usan los tokenIds que la app conoce (protecciones y orquestadores) con
  `ownerOf`; la UI avisa que solo se ven los LPs creados desde la app.
- LPs con liquidez 0 no se muestran ni suman (tampoco sus fees residuales).
- HL unificada = `userAbstraction` distinto de `disabled`: se excluye el USDC de
  spot (ya está en `accountValue`). Sin verificar contra una cuenta unificada real.
- Se retiraron `orchestrator-metrics.*`, `orchestrator-account-resolver.js` y
  `listForMetricsCapture`. `server/weekly-hedge-report.js` sigue leyendo la tabla
  vieja, que ya no recibe datos.

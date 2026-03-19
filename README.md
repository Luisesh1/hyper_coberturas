# Hyperliquid Trading Bot

Bot de trading automatizado para [Hyperliquid](https://hyperliquid.xyz) con interfaz web. Soporta trading manual, coberturas automáticas cíclicas (hedges) y notificaciones por Telegram.

## Características

- **Trading manual** — abrir/cerrar posiciones apalancadas con Stop Loss y Take Profit desde la UI
- **Coberturas automáticas** — ciclos continuos SHORT/LONG entre dos niveles de precio hasta cancelación manual
- **Alertas Telegram** — notificación en tiempo real de aperturas, cierres y errores
- **Feed de precios en vivo** — WebSocket conectado al feed `allMids` de Hyperliquid
- **Multi-usuario** — cada usuario tiene su propia wallet, bot de Telegram y estado de coberturas
- **API key support** — soporta firma con API key separada de la cuenta principal

## Arquitectura

```
browser ──▶ nginx:5174
              ├── /api/*  ──▶ server:3001  (Express REST + WebSocket)
              │                  ├── PostgreSQL  (estado persistente)
              │                  └── Hyperliquid WS  (feed de precios y fills)
              └── /*      ──▶ frontend:5174  (React + Vite, dev con HMR)
```

### Stack

| Capa       | Tecnología                                  |
|------------|---------------------------------------------|
| Frontend   | React 18, Vite, CSS Modules                 |
| Backend    | Node.js, Express, WebSocket (`ws`)          |
| Base datos | PostgreSQL 16                               |
| Firma      | ethers v6, @msgpack/msgpack (EIP-712)       |
| Infra      | Docker Compose (dev y prod), nginx          |

## Requisitos

- [Docker](https://docs.docker.com/get-docker/) y Docker Compose v2
- Una wallet de Hyperliquid (o API key vinculada a una cuenta)
- *(Opcional)* Bot de Telegram para notificaciones

## Inicio rápido

### 1. Clonar y configurar

```bash
git clone git@github.com:Luisesh1/hyper_coberturas.git
cd hyper_coberturas

cp server/.env.example server/.env
```

Editar `server/.env` con al menos un `JWT_SECRET` seguro. La wallet y el bot de Telegram se configuran desde la UI una vez iniciado.

Inicializar esquema y superusuario de desarrollo:

```bash
npm run migrate
npm run seed:dev
```

### 2. Levantar en desarrollo

```bash
docker compose up --build
```

Abrir [http://localhost:5174](http://localhost:5174).

El usuario de desarrollo se crea con `npm run seed:dev` y puede crear usuarios adicionales desde el panel de administración.

### 3. Producción

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

Sirve en el puerto 80. El frontend se compila estáticamente y nginx lo sirve directamente.

## Configuración de wallet

Desde **Ajustes → Wallet**:

- **Dirección de cuenta** (`address`): la dirección pública de tu cuenta en Hyperliquid
- **Clave privada** (`privateKey`): puede ser la clave maestra o una [API key](https://app.hyperliquid.xyz/API) autorizada

> La clave privada se almacena cifrada en la base de datos PostgreSQL y nunca sale del servidor.

## Configuración de Telegram

Desde **Ajustes → Telegram**:

1. Crear un bot con [@BotFather](https://t.me/BotFather) y copiar el token
2. Obtener tu `chat_id` (ej. con [@userinfobot](https://t.me/userinfobot))
3. Guardar y usar el botón **Probar** para verificar la conexión

## Coberturas automáticas

Una cobertura protege capital en otras plataformas abriendo y cerrando posiciones en Hyperliquid de forma cíclica:

| Dirección | Entrada                          | Salida (SL)                       |
|-----------|----------------------------------|-----------------------------------|
| SHORT     | Precio ≤ `entryPrice` (SELL STOP)| Precio ≥ `exitPrice`              |
| LONG      | Precio ≥ `entryPrice` (BUY STOP) | Precio ≤ `exitPrice`              |

El ciclo se repite automáticamente hasta que el usuario cancela la cobertura.

**Orden de entrada**: stop-market nativo de Hyperliquid (fee taker 0.05%)
**Stop Loss**: trigger order nativa sobre la posición abierta
**Fee de entry SHORT**: intenta ALO (maker 0.02%) con fallback a GTC

## Comandos Docker útiles

```bash
# Ver logs del backend
docker compose logs -f server

# Inicializar DB y superusuario dev
npm run migrate
npm run seed:dev

# Reiniciar solo el backend (sin reconstruir)
docker compose restart server

# Acceder a la base de datos
docker compose exec postgres psql -U testbot -d testbot

# Parar todo
docker compose down

# Parar y borrar volúmenes (reset total)
docker compose down -v
```

## Estructura del proyecto

```
├── client/                  # Frontend React
│   ├── src/
│   │   ├── components/      # HedgePanel, TradingPanel, SettingsPanel, ...
│   │   ├── context/         # TradingContext (estado global)
│   │   ├── hooks/           # useWebSocket, usePrices, ...
│   │   └── services/        # api.js (cliente HTTP)
│   └── Dockerfile
│
├── server/                  # Backend Node.js
│   ├── src/
│   │   ├── routes/          # REST endpoints
│   │   ├── services/        # Lógica de negocio
│   │   │   ├── hyperliquid.service.js   # Firma EIP-712 + API HL
│   │   │   ├── hedge.service.js         # Motor de coberturas automáticas
│   │   │   ├── trading.service.js       # Trading manual
│   │   │   └── telegram.service.js      # Notificaciones
│   │   ├── db/              # Pool PostgreSQL + migraciones al arranque
│   │   ├── middleware/       # Auth JWT
│   │   └── websocket/       # wsServer.js + hyperliquidWs.js
│   ├── .env.example
│   └── Dockerfile
│
├── nginx/                   # Configuraciones nginx dev y prod
├── docker-compose.yml       # Desarrollo
└── docker-compose.prod.yml  # Producción
```

## Variables de entorno

Ver [`server/.env.example`](server/.env.example) para la referencia completa.

Las variables de base de datos (`DATABASE_URL`) son inyectadas por Docker Compose en desarrollo. En producción se pueden definir en `server/.env`.

## Seguridad

- Las claves privadas se guardan en la DB; usar PostgreSQL con contraseña fuerte en producción
- `JWT_SECRET` debe ser un valor aleatorio largo (mínimo 32 bytes)
- El endpoint `/api` no debe exponerse directamente; usar siempre nginx como proxy
- No commitear `.env` al repositorio
- Regla del proyecto: antes de cualquier proceso con alto impacto sobre la base de datos, crear un backup verificable. Esto incluye restauraciones, migraciones delicadas, limpiezas masivas, reseteos, cambios manuales en producción, rotación de claves que afecten datos cifrados y cualquier operación con riesgo de pérdida o corrupción.

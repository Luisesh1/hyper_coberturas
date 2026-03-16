# Guia de Despliegue — Hyperliquid Trading Bot

## Indice

1. [Requisitos previos](#1-requisitos-previos)
2. [Desarrollo — Inicio rapido](#2-desarrollo--inicio-rapido)
3. [Produccion — Despliegue paso a paso](#3-produccion--despliegue-paso-a-paso)
4. [Manejo de datos sensibles (Secrets)](#4-manejo-de-datos-sensibles-secrets)
5. [Backups y restauracion](#5-backups-y-restauracion)
6. [Mantenimiento](#6-mantenimiento)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Requisitos previos

| Componente | Version minima |
|------------|----------------|
| Docker     | 24.0+          |
| Docker Compose | v2 (integrado en Docker Desktop) |
| RAM servidor | 2 GB (produccion) |
| Disco      | 20 GB minimo   |

Verificar instalacion:

```bash
docker --version
docker compose version
```

---

## 2. Desarrollo — Inicio rapido

### 2.1 Clonar y configurar

```bash
git clone <url-del-repo>
cd testbotCobertura
```

### 2.2 Crear archivo .env en la raiz

```bash
cp .env.example .env
```

Editar `.env` y definir al menos:

```env
POSTGRES_PASSWORD=una_password_de_desarrollo
```

### 2.3 Configurar el servidor

```bash
cp server/.env.example server/.env
```

Para desarrollo los valores por defecto son suficientes. Opcionalmente genera secrets seguros:

```bash
# Generar JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generar SETTINGS_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2.4 Levantar el sistema

```bash
docker compose up --build
```

Esperar a que todos los servicios esten saludables. Verificar:

```bash
docker compose ps
```

Todos los servicios deben mostrar `(healthy)` en su estado.

### 2.5 Acceder a la aplicacion

Abrir [http://localhost:5174](http://localhost:5174)

### 2.6 Crear usuario administrador

```bash
docker compose exec server npm run seed:dev
```

Credenciales por defecto: `admin` / `admin123` (solo desarrollo).

### 2.7 Comandos utiles en desarrollo

```bash
# Ver logs del backend en tiempo real
docker compose logs -f server

# Reiniciar solo el backend (sin reconstruir)
docker compose restart server

# Acceder a la base de datos
docker compose exec postgres psql -U testbot -d testbot

# Detener todo
docker compose down

# Detener y borrar volumenes (RESET TOTAL — borra datos)
docker compose down -v
```

---

## 3. Produccion — Despliegue paso a paso

### 3.1 Preparar el servidor

```bash
git clone <url-del-repo>
cd testbotCobertura
```

### 3.2 Crear .env en la raiz del proyecto

```bash
cp .env.example .env
```

Editar `.env` con valores de produccion:

```env
# Base de datos
POSTGRES_DB=testbot
POSTGRES_USER=testbot
POSTGRES_PASSWORD=<password-seguro-generado>

# URL del frontend (dominio real o IP del servidor)
CLIENT_URL=http://tu-servidor-ip

# Puerto externo de nginx (opcional, default 80)
# NGINX_PORT=80
```

**Generar password seguro para PostgreSQL:**

```bash
openssl rand -hex 24
```

### 3.3 Configurar server/.env

```bash
cp server/.env.example server/.env
```

Editar `server/.env` con valores de produccion:

```env
NODE_ENV=production
PORT=3001

# APIs externas (pueden quedarse con los defaults)
HL_API_URL=https://api.hyperliquid.xyz
HL_WS_URL=wss://api.hyperliquid.xyz/ws

# OBLIGATORIO: generar valores unicos y seguros
JWT_SECRET=<valor-generado>
SETTINGS_ENCRYPTION_KEY=<valor-generado>
```

**Generar secrets:**

```bash
# JWT_SECRET (copiar y pegar en server/.env)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# SETTINGS_ENCRYPTION_KEY (copiar y pegar en server/.env)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3.4 Construir y desplegar

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

### 3.5 Verificar que todo funciona

```bash
# Ver estado de los contenedores (todos deben ser "healthy")
docker compose -f docker-compose.prod.yml ps

# Verificar health endpoint
curl http://localhost/api/health

# Verificar readiness completa
curl http://localhost/api/health/ready

# Verificar security headers
curl -I http://localhost
```

### 3.6 Crear usuario administrador

```bash
docker compose -f docker-compose.prod.yml exec server node src/scripts/seed-dev.js
```

**Cambiar inmediatamente** la contrasena del administrador desde la UI.

### 3.7 Configurar la wallet

1. Acceder a la UI
2. Ir a **Ajustes → Wallet**
3. Agregar direccion de la cuenta y clave privada (o API key)
4. La clave se almacena cifrada en la base de datos

---

## 4. Manejo de datos sensibles (Secrets)

### 4.1 Tabla de secrets

| Variable | Proposito | Como generarlo | Donde va |
|----------|-----------|----------------|----------|
| `POSTGRES_PASSWORD` | Password de la base de datos | `openssl rand -hex 24` | `.env` (raiz) |
| `JWT_SECRET` | Firma de tokens de sesion | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | `server/.env` |
| `SETTINGS_ENCRYPTION_KEY` | Cifrado de claves privadas y tokens en la DB | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | `server/.env` |
| `CLIENT_URL` | Origen permitido para CORS | Definir manualmente (ej: `http://mi-servidor`) | `.env` (raiz) |

### 4.2 Reglas de seguridad

**HACER:**
- Generar secrets unicos y aleatorios para cada entorno
- Usar al menos 32 bytes (64 caracteres hex) para JWT_SECRET y SETTINGS_ENCRYPTION_KEY
- Usar passwords fuertes para PostgreSQL (minimo 24 caracteres)
- Proteger los archivos `.env` con permisos restrictivos: `chmod 600 .env server/.env`
- Rotar secrets periodicamente (ver seccion 4.3)

**NUNCA:**
- Commitear archivos `.env` al repositorio (`.gitignore` los excluye)
- Usar valores por defecto en produccion (`change-me`, `admin123`, etc.)
- Compartir secrets por canales no seguros (chat, email)
- Dejar `CLIENT_URL=*` en produccion
- Exponer el puerto de PostgreSQL (5432) al exterior

### 4.3 Rotacion de secrets

#### Rotar JWT_SECRET

Esto invalidara todas las sesiones activas. Los usuarios tendran que iniciar sesion de nuevo.

```bash
# 1. Generar nuevo secret
NEW_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "Nuevo JWT_SECRET: $NEW_SECRET"

# 2. Actualizar server/.env con el nuevo valor

# 3. Reiniciar el servidor
docker compose -f docker-compose.prod.yml restart server
```

#### Rotar SETTINGS_ENCRYPTION_KEY

**PELIGRO:** Cambiar esta clave hara que las claves privadas y tokens almacenados en la base de datos sean ilegibles. Solo rotar si se sospecha compromiso, y re-configurar wallets y Telegram despues.

```bash
# 1. Actualizar SETTINGS_ENCRYPTION_KEY en server/.env
# 2. Reiniciar el servidor
docker compose -f docker-compose.prod.yml restart server
# 3. Re-configurar wallets y Telegram desde la UI
```

#### Rotar POSTGRES_PASSWORD

```bash
# 1. Acceder al contenedor de postgres
docker compose -f docker-compose.prod.yml exec postgres psql -U testbot -d testbot

# 2. Cambiar la contrasena
ALTER USER testbot WITH PASSWORD 'nueva_password_segura';

# 3. Actualizar .env con la nueva password
# 4. Actualizar DATABASE_URL si esta definida manualmente en server/.env
# 5. Reiniciar el servidor
docker compose -f docker-compose.prod.yml restart server
```

---

## 5. Backups y restauracion

### 5.1 Backup manual

```bash
# Backup completo de la base de datos
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U testbot -d testbot --format=custom \
  -f /backups/testbot_$(date +%Y%m%d_%H%M%S).dump

# Listar backups existentes
docker compose -f docker-compose.prod.yml exec postgres ls -la /backups/
```

### 5.2 Restaurar un backup

```bash
# 1. Detener el servidor (para evitar escrituras)
docker compose -f docker-compose.prod.yml stop server

# 2. Restaurar el backup
docker compose -f docker-compose.prod.yml exec postgres \
  pg_restore -U testbot -d testbot --clean --if-exists \
  /backups/testbot_20240101_120000.dump

# 3. Reiniciar el servidor
docker compose -f docker-compose.prod.yml start server
```

### 5.3 Backup automatico con cron

Agregar al crontab del servidor host (`crontab -e`):

```cron
# Backup diario a las 3:00 AM
0 3 * * * cd /ruta/al/proyecto && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U testbot -d testbot --format=custom -f /backups/testbot_$(date +\%Y\%m\%d_\%H\%M\%S).dump

# Limpiar backups mayores a 30 dias (cada domingo a las 4:00 AM)
0 4 * * 0 cd /ruta/al/proyecto && docker compose -f docker-compose.prod.yml exec -T postgres find /backups -name "*.dump" -mtime +30 -delete
```

### 5.4 Copiar backup al host

```bash
# Copiar ultimo backup del contenedor al host
docker cp testbot-postgres-prod:/backups/ ./backups/
```

---

## 6. Mantenimiento

### 6.1 Ver logs

```bash
# Todos los servicios
docker compose -f docker-compose.prod.yml logs -f

# Solo el backend
docker compose -f docker-compose.prod.yml logs -f server

# Ultimas 100 lineas
docker compose -f docker-compose.prod.yml logs --tail=100 server
```

### 6.2 Actualizar la aplicacion

```bash
# 1. Descargar cambios
git pull origin main

# 2. Reconstruir y reiniciar
docker compose -f docker-compose.prod.yml up --build -d

# 3. Verificar que todo esta saludable
docker compose -f docker-compose.prod.yml ps
curl http://localhost/api/health/ready
```

### 6.3 Reiniciar servicios individuales

```bash
# Reiniciar solo el backend (sin reconstruir)
docker compose -f docker-compose.prod.yml restart server

# Reiniciar nginx (ej: despues de cambiar config)
docker compose -f docker-compose.prod.yml restart nginx
```

### 6.4 Acceder a la base de datos

```bash
docker compose -f docker-compose.prod.yml exec postgres psql -U testbot -d testbot
```

### 6.5 Monitoreo

El endpoint `/api/health/ready` devuelve el estado de todos los componentes:

```bash
curl -s http://localhost/api/health/ready | jq
```

Respuesta esperada:

```json
{
  "status": "ready",
  "checks": {
    "db": true,
    "hyperliquidWs": true,
    "bootstrapped": true
  }
}
```

Si `status` es `"degraded"`, revisar que componente falla en `checks`.

### 6.6 Uso de disco

```bash
# Ver tamano de volumenes Docker
docker system df -v | grep testbot

# Ver tamano de la base de datos
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U testbot -d testbot -c "SELECT pg_size_pretty(pg_database_size('testbot'));"
```

---

## 7. Troubleshooting

### El servidor no arranca

**Sintoma:** `testbot-server-prod` en estado `unhealthy` o `restarting`

```bash
# Ver logs del servidor
docker compose -f docker-compose.prod.yml logs server
```

**Causas comunes:**
- `JWT_SECRET inseguro o ausente en producción` → Generar un JWT_SECRET seguro en `server/.env`
- `SETTINGS_ENCRYPTION_KEY es obligatoria en producción` → Generar en `server/.env`
- `CLIENT_URL=* no está permitido en producción` → Definir `CLIENT_URL` con URL concreta en `.env`
- `DATABASE_URL es requerido en producción` → Se inyecta automaticamente por docker-compose, verificar que postgres esta healthy

### La base de datos no conecta

```bash
# Verificar que postgres esta corriendo
docker compose -f docker-compose.prod.yml ps postgres

# Verificar health check
docker compose -f docker-compose.prod.yml exec postgres pg_isready -U testbot

# Verificar que POSTGRES_PASSWORD coincide
docker compose -f docker-compose.prod.yml exec postgres env | grep POSTGRES
```

### WebSocket no conecta

```bash
# Verificar que el servidor esta escuchando
docker compose -f docker-compose.prod.yml exec server node -e "fetch('http://localhost:3001/api/health').then(r=>r.json()).then(console.log)"

# Verificar que nginx esta proxy-ando
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" http://localhost/ws
```

### Reset total (BORRA TODOS LOS DATOS)

```bash
# Detener y eliminar contenedores + volumenes
docker compose -f docker-compose.prod.yml down -v

# Reconstruir desde cero
docker compose -f docker-compose.prod.yml up --build -d

# Re-crear usuario admin
docker compose -f docker-compose.prod.yml exec server node src/scripts/seed-dev.js
```

---

## Arquitectura de red

```
Internet / LAN
       │
       ▼
┌──────────────┐
│  nginx:80    │  ← Unico punto de entrada
│  (reverse    │
│   proxy)     │
└──────┬───────┘
       │  testbot-network (bridge)
       │
  ┌────┴────┐
  │         │
  ▼         ▼
┌─────┐  ┌──────────────┐
│ /ws │  │ /api/*       │
└──┬──┘  └──────┬───────┘
   │            │
   ▼            ▼
┌──────────────────┐
│  server:3001     │  ← Backend Node.js
│  (Express + WS)  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│  postgres:5432   │     │  Hyperliquid API  │
│  (datos)         │     │  (externo)        │
└──────────────────┘     └──────────────────┘
```

Ningun servicio excepto nginx expone puertos al exterior.

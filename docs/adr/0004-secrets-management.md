# ADR 0004 — Gestión de secretos (JWT_SECRET / SETTINGS_ENCRYPTION_KEY)

## Estado

Propuesto — 2026-04-20.

## Contexto

El backend depende de dos secretos críticos:

- `JWT_SECRET`: firma/verifica los JWT emitidos a los usuarios.
- `SETTINGS_ENCRYPTION_KEY`: AES-256-GCM sobre las claves privadas de las
  wallets almacenadas en `settings.accounts.*` (ver `settings.crypto.js`).

Hoy ambos se leen desde variables de entorno (`server/.env` en prod,
inyectadas por `docker-compose.prod.yml` vía `env_file:`). La validación
fail-fast en `server/src/config/index.js:158-190` garantiza que no se
arranque en PROD con defaults inseguros.

Riesgos residuales del esquema actual:

1. **Visibilidad en el host**: cualquiera con acceso al socket de Docker
   (`docker inspect testbot-server-prod`) ve los valores. Incluye procesos
   con `/var/run/docker.sock` montado.
2. **Rotación manual**: cambiar el secret requiere redeploy + re-encriptar
   datos sensibles. Sin un flujo de rotación orquestado, el secret "vive
   para siempre" y un leak es permanente hasta detectar y rotar.
3. **Auditoría**: no hay log de "quién leyó el secret y cuándo".
4. **Granularidad**: toda la app comparte el mismo `SETTINGS_ENCRYPTION_KEY`.
   Un compromiso del secret revela todas las claves de todos los usuarios.

## Decisión

A corto plazo (pre-launch):

- Mantener env vars con `validateConfig()` fail-fast ya existente.
- Generar los secretos con `openssl rand -base64 48` y guardarlos en
  `server/.env` con permisos `600`, nunca comiteados.
- Rotar `JWT_SECRET` cada 90 días (invalida sesiones; aceptable tras
  comunicar mantenimiento corto).
- Documentar el procedimiento de rotación en `DEPLOYMENT.md`.

A medio plazo (post Fase 1):

- Migrar a un gestor de secretos con rotación automatizada y auditoría.
  Candidatos evaluados:

  | Opción                    | Pros | Contras | Operación |
  |---------------------------|------|---------|-----------|
  | **HashiCorp Vault** (self-hosted) | On-prem, KV + transit engine para firmar sin exportar la key; dynamic secrets para DB | Requiere HA + unseal procedure; coste operativo alto | Docker Compose inicial, migración a k8s futura |
  | **AWS Secrets Manager / KMS** | Gestión total, rotación automática; envelope encryption con KMS | Vendor lock-in AWS; requiere IAM correcto; coste $$ | IAM role por contenedor |
  | **Infisical** (open source) | UX moderno, sync a env, Docker-friendly | Proyecto joven; menos integraciones que Vault | Autohost con Docker Compose |
  | **SOPS + age** (stateless) | Secretos en Git encriptados; sin servidor | Sin rotación automática; aún requires key management | Sólo build-time |

  Recomendación preliminar: **Vault** si se espera escala multi-servicio
  propia, **AWS Secrets Manager** si el resto de infra cae en AWS. La
  decisión definitiva se pospone hasta tener feedback post-launch sobre
  carga operativa y cost targets.

A largo plazo (post Fase 3):

- Sustituir `SETTINGS_ENCRYPTION_KEY` por **envelope encryption**: cada
  cuenta tendrá su propia DEK (data encryption key), encriptada por la
  KEK (key encryption key) del gestor. Comprometer la KEK no revela las
  DEKs cacheadas; comprometer una DEK sólo afecta a una cuenta.

## Consecuencias

- Coste operativo aumenta con el gestor (Vault/ASM), pero reduce radio
  de impacto de un leak.
- La migración requerirá re-encriptar el payload existente en
  `settings.accounts.*` con envelope encryption; se hará en una
  ventana de mantenimiento con backup completo previo.
- El código existente (`settings.crypto.js`) ya encapsula AES-256-GCM
  y es compatible con un reemplazo del provider de clave.

## Alternativas consideradas

- **Mantener env vars indefinidamente**: barato, pero cierra la puerta a
  auditoría y rotación automatizada. Inaceptable a escala.
- **Encriptar sólo con cert TLS del cliente**: requiere que cada usuario
  controle su propia KMS; complica UX para el usuario no técnico.

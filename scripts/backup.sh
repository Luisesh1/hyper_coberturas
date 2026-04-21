#!/usr/bin/env sh
# ──────────────────────────────────────────────────────────────────
# scripts/backup.sh
#
# pg_dump del schema+datos a /backups con retención automática.
# Pensado para ejecutarse:
#   - manualmente:  sh scripts/backup.sh
#   - dentro del contenedor `backup` del compose (cron sidecar).
#
# Variables de entorno:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE  — conexión
#   BACKUP_DIR        = /backups                    — destino
#   BACKUP_RETENTION_DAYS = 7                       — días a conservar
# ──────────────────────────────────────────────────────────────────
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-testbot}"
PGDATABASE="${PGDATABASE:-testbot}"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="${BACKUP_DIR}/${PGDATABASE}_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[backup] dumping ${PGDATABASE}@${PGHOST}:${PGPORT} → ${DEST}"
PGPASSWORD="${PGPASSWORD:?PGPASSWORD requerido}" pg_dump \
    -h "${PGHOST}" \
    -p "${PGPORT}" \
    -U "${PGUSER}" \
    -d "${PGDATABASE}" \
    --no-owner --no-privileges \
    | gzip -9 > "${DEST}"

BYTES=$(stat -c '%s' "${DEST}" 2>/dev/null || wc -c < "${DEST}")
echo "[backup] written ${BYTES} bytes"

# Retención: elimina dumps con mtime mayor a RETENTION_DAYS días.
if [ -n "${RETENTION_DAYS}" ] && [ "${RETENTION_DAYS}" -gt 0 ] 2>/dev/null; then
    echo "[backup] pruning files older than ${RETENTION_DAYS} days"
    find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${PGDATABASE}_*.sql.gz" \
        -mtime "+${RETENTION_DAYS}" -print -delete || true
fi

echo "[backup] done"

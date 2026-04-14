# ──────────────────────────────────────────────
# Hyperliquid Bot — Frontend
# ──────────────────────────────────────────────
# Dev:  target=development  (Vite dev server + HMR)
# Prod: target=production   (nginx sirviendo build estatico)

# === Desarrollo (Vite dev server) ===
# Nota: corre como root por la misma razon que el server (cuota inotify).
FROM node:22-alpine AS development
WORKDIR /app
COPY package*.json ./
RUN npm ci
# El codigo se monta como volumen en docker-compose
EXPOSE 5174
STOPSIGNAL SIGTERM
CMD ["sh", "-c", "npx vite --host 0.0.0.0 --port ${VITE_PORT:-5174}"]

# === Build de produccion (usuario non-root) ===
FROM node:22-alpine AS builder
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci
COPY --chown=node:node . .
RUN npm run build

# === Produccion (solo el artefacto — nginx lo usa via Dockerfile.prod) ===
FROM builder AS production
# Artefacto en /app/dist — copiado por nginx/Dockerfile.prod

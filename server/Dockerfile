# ──────────────────────────────────────────────
# Hyperliquid Bot — Backend
# ──────────────────────────────────────────────
# Dev:  docker-compose up (nodemon, hot reload)
# Prod: docker-compose -f docker-compose.prod.yml up (node)

# === Base compartida ===
FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./

# === Desarrollo (nodemon + hot reload) ===
FROM base AS development
RUN npm ci
# El codigo se monta como volumen en docker-compose
EXPOSE 3001
CMD ["node_modules/.bin/nodemon", "--signal", "SIGTERM", "index.js"]

# === Produccion (dependencias minimas) ===
FROM base AS production
RUN npm ci --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]

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
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "index.js"]

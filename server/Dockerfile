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
# Nota: el target de desarrollo corre como root para evitar colisiones de
# cuota inotify con el usuario host (uid 1000 compartido). El hardening
# non-root se aplica solo en el target de produccion.
FROM base AS development
RUN npm ci
# El codigo se monta como volumen en docker-compose
EXPOSE 3001
STOPSIGNAL SIGTERM
CMD ["node_modules/.bin/nodemon", "--signal", "SIGTERM", "index.js"]

# === Produccion (dependencias minimas, usuario non-root) ===
FROM base AS production
RUN npm ci --omit=dev
COPY . .
RUN chown -R node:node /app
USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "index.js"]

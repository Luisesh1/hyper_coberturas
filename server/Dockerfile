# ──────────────────────────────────────────────
# Hyperliquid Bot — Backend
# ──────────────────────────────────────────────
# Dev:  docker-compose up (nodemon, hot reload)
# Prod: docker-compose -f docker-compose.prod.yml up (node)

# === Base compartida ===
FROM node:22-alpine AS base
WORKDIR /app
# node:22-alpine incluye el usuario `node` (uid=1000). Asignamos la propiedad
# del WORKDIR para que `npm ci` pueda escribir sin privilegios root.
RUN chown node:node /app
COPY --chown=node:node package*.json ./

# === Desarrollo (nodemon + hot reload) ===
FROM base AS development
USER node
RUN npm ci
# El codigo se monta como volumen en docker-compose
EXPOSE 3001
STOPSIGNAL SIGTERM
CMD ["node_modules/.bin/nodemon", "--signal", "SIGTERM", "index.js"]

# === Produccion (dependencias minimas) ===
FROM base AS production
USER node
RUN npm ci --omit=dev
COPY --chown=node:node . .
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=30s \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "index.js"]

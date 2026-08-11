const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('./config');
const { IS_PROD } = require('./config');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { requestContext } = require('./middleware/request-context.middleware');
const { requestLogger } = require('./middleware/request-logger.middleware');
const { buildSuccessEnvelope } = require('./shared/platform/http/response-envelope');

const app = express();

// En producción Express recibe las requests desde un único proxy Nginx. Sin
// este ajuste `req.ip` sería siempre la IP interna del contenedor y todos los
// clientes compartirían el mismo rate limit.
if (IS_PROD) app.set('trust proxy', 1);

function rateLimitKey(req) {
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) {
    try {
      // Solo verificamos la firma para seleccionar el bucket. La validación de
      // sesión completa sigue perteneciendo al middleware de autenticación.
      const payload = jwt.verify(authorization.slice(7), config.jwt.secret);
      if (payload?.userId != null) return `user:${payload.userId}`;
    } catch {
      // Un token inválido conserva el bucket por IP y luego será rechazado por auth.
    }
  }
  return ipKeyGenerator(req.ip);
}

// ------------------------------------------------------------------
// Security headers (helmet)
// ------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: IS_PROD ? undefined : false, // desactivar CSP en dev (Vite HMR)
}));

// ------------------------------------------------------------------
// Rate limiting global
// ------------------------------------------------------------------
app.use(rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { success: false, error: 'Demasiadas peticiones, intenta de nuevo más tarde' },
}));

// ------------------------------------------------------------------
// CORS
// ------------------------------------------------------------------
// En docker/prod todo pasa por nginx (mismo origen) → sin CORS necesario.
// En dev local (sin docker) se permite CLIENT_URL.
// CLIENT_URL=* solo permitido en desarrollo; en prod rechazamos wildcard.
if (IS_PROD && (!config.server.clientUrl || config.server.clientUrl === '*')) {
  throw new Error('CLIENT_URL debe estar configurado y no puede ser "*" en producción');
}
const corsOrigin = (!IS_PROD && config.server.clientUrl === '*')
  ? true
  : config.server.clientUrl;

app.use(
  cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestContext);
app.use(requestLogger);

// ------------------------------------------------------------------
// Rutas
// ------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json(buildSuccessEnvelope({
    message: 'Backend activo',
  }));
});

app.use('/api', routes);

// ------------------------------------------------------------------
// Manejo de errores (siempre al final)
// ------------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;

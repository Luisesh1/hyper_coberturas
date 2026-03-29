const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('./config');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { requestContext } = require('./middleware/request-context.middleware');
const { requestLogger } = require('./middleware/request-logger.middleware');

const IS_PROD = config.server.nodeEnv === 'production';

const app = express();

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
  keyGenerator: (req) => req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req.ip),
  message: { success: false, error: 'Demasiadas peticiones, intenta de nuevo más tarde' },
}));

// ------------------------------------------------------------------
// CORS
// ------------------------------------------------------------------
// En docker/prod todo pasa por nginx (mismo origen) → sin CORS necesario.
// En dev local (sin docker) se permite CLIENT_URL.
// CLIENT_URL=* solo permitido en desarrollo.
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
  res.json({
    success: true,
    message: 'Backend activo',
  });
});

app.use('/api', routes);

// ------------------------------------------------------------------
// Manejo de errores (siempre al final)
// ------------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;

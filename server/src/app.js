const express = require('express');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const app = express();

// ------------------------------------------------------------------
// Middlewares globales
// ------------------------------------------------------------------
// En docker todo pasa por nginx (mismo origen) → sin CORS.
// En dev local (sin docker) se permite CLIENT_URL.
// CLIENT_URL=* desactiva la restriccion (dev sin docker).
const corsOrigin = config.server.clientUrl === '*'
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

// ------------------------------------------------------------------
// Rutas
// ------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Backend activo',
    docs: '/api/health',
    frontend: config.server.clientUrl,
  });
});

app.use('/api', routes);

// ------------------------------------------------------------------
// Manejo de errores (siempre al final)
// ------------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;

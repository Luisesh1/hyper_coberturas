class AppError extends Error {
  constructor(message, { status = 500, code = 'APP_ERROR', details = null, cause = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

class AuthError extends AppError {
  constructor(message = 'No autenticado', details = null) {
    super(message, { status: 401, code: 'AUTH_ERROR', details });
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Acceso denegado', details = null) {
    super(message, { status: 403, code: 'FORBIDDEN', details });
  }
}

class NotFoundError extends AppError {
  constructor(message = 'No encontrado', details = null) {
    super(message, { status: 404, code: 'NOT_FOUND', details });
  }
}

class ExternalServiceError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 502, code: 'EXTERNAL_SERVICE_ERROR', details });
  }
}

class ConfigError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 500, code: 'CONFIG_ERROR', details });
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ExternalServiceError,
  ConfigError,
};

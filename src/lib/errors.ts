export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expose = status < 500;
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'bad_request', message, { details });
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(401, 'unauthorized', message);
  }

  static forbidden(message = 'Not allowed'): AppError {
    return new AppError(403, 'forbidden', message);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, 'not_found', message);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, 'conflict', message, { details });
  }

  static payloadTooLarge(message = 'Request body too large'): AppError {
    return new AppError(413, 'payload_too_large', message);
  }

  static unprocessable(message: string, details?: unknown): AppError {
    return new AppError(422, 'unprocessable_entity', message, { details });
  }

  static tooManyRequests(message = 'Too many requests'): AppError {
    return new AppError(429, 'too_many_requests', message);
  }

  static internal(message = 'Internal server error', cause?: unknown): AppError {
    return new AppError(500, 'internal_error', message, { cause });
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

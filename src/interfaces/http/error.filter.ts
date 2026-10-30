import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ApplicationError,
  IdempotencyConflictError,
  NotFoundError,
  PayloadValidationError,
  PermanentProcessingError,
  ResourceConflictError,
  TransientInfrastructureError,
} from "../../application/errors";
import type { AppLogger } from "../../application/ports/observability";
import { correlationIdOf } from "./correlation";

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
  correlationId: string;
}

/**
 * One status per error class, identical on every endpoint:
 *   400 INVALID_PAYLOAD / INVALID_JSON           fix the request
 *   404 NOT_FOUND
 *   409 IDEMPOTENCY_CONFLICT / *_ALREADY_EXISTS  never retry as-is
 *   503 TRANSIENT_INFRASTRUCTURE_ERROR           retry as-is (Retry-After)
 *   500 PERMANENT_PROCESSING_ERROR / INTERNAL_ERROR
 */
export function statusFor(error: ApplicationError): number {
  if (error instanceof PayloadValidationError) return HttpStatus.BAD_REQUEST;
  if (error instanceof NotFoundError) return HttpStatus.NOT_FOUND;
  if (error instanceof IdempotencyConflictError || error instanceof ResourceConflictError) return HttpStatus.CONFLICT;
  if (error instanceof TransientInfrastructureError) return HttpStatus.SERVICE_UNAVAILABLE;
  if (error instanceof PermanentProcessingError) return HttpStatus.INTERNAL_SERVER_ERROR;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const correlationId = correlationIdOf(req);

    let status: number;
    let body: ErrorBody["error"];

    if (exception instanceof ApplicationError) {
      status = statusFor(exception);
      body = { code: exception.code, message: exception.message, ...(exception.details ? { details: exception.details } : {}) };
      if (exception instanceof TransientInfrastructureError) res.setHeader("Retry-After", "1");
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse() as { code?: string; message?: string | string[] } | string;
      const message = typeof response === "string" ? response : [response.message].flat().join("; ");
      const code =
        typeof response === "object" && response.code
          ? response.code
          : status === 400
            ? "INVALID_JSON"
            : status === 404
              ? "NOT_FOUND"
              : status === 403
                ? "FORBIDDEN"
                : `HTTP_${status}`;
      body = { code, message: message || exception.message };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = { code: "INTERNAL_ERROR", message: "Unexpected error" };
      this.logger.error("unhandled http error", {
        correlationId,
        path: req.path,
        err: exception instanceof Error ? exception.message : String(exception),
      });
    }

    res.status(status).json({ error: body, correlationId } satisfies ErrorBody);
  }
}

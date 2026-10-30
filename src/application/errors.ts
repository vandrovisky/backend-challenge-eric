/**
 * Application-level errors. Each kind maps to ONE HTTP status and ONE SQS handling policy,
 * so callers never have to parse messages to decide whether to retry:
 *
 *   PayloadValidationError       400  → SQS: permanent (DLQ)    provider must fix the request
 *   IdempotencyConflictError     409  → SQS: permanent (DLQ)    same key, different payload
 *   ResourceConflictError        409                           e.g. wallet already exists
 *   NotFoundError                404
 *   TransientInfrastructureError 503  → SQS: retry with backoff  safe to resend as-is
 *   PermanentProcessingError     500  → SQS: permanent (DLQ)    recorded as FAILED
 *
 * Business rejections are NOT errors: they are a normal result with status REJECTED.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  protected constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class PayloadValidationError extends ApplicationError {
  readonly code = "INVALID_PAYLOAD";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class ResourceConflictError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends ApplicationError {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
  }
}

export type TransientReason = "lock_timeout" | "deadlock" | "serialization" | "connection" | "timeout" | "contention" | "other";

export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_INFRASTRUCTURE_ERROR";
  constructor(
    message: string,
    override readonly cause?: unknown,
    readonly reason: TransientReason = "other",
  ) {
    super(message);
  }
}

export class PermanentProcessingError extends ApplicationError {
  readonly code = "PERMANENT_PROCESSING_ERROR";
  constructor(
    message: string,
    readonly transactionId?: string,
  ) {
    super(message, transactionId ? { transactionId } : undefined);
  }
}

/** Optimistic guard tripped: the wallet moved between our read and our write. Retryable. */
export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

/** Unique-constraint race (two writers inserted the same key). The caller retries into the replay path. */
export class DuplicateKeyError extends Error {
  constructor(readonly constraint: string) {
    super(`duplicate key: ${constraint}`);
    this.name = "DuplicateKeyError";
  }
}

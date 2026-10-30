/**
 * Base for every error raised by the domain. `code` is stable and machine-readable;
 * the application layer maps it to HTTP status / SQS handling without parsing messages.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
  constructor() {
    super("Insufficient funds");
  }
}

export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";
  constructor(message: string) {
    super(message);
  }
}

/** Programming error: attempting to move a transaction out of a terminal state. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
  constructor(message: string) {
    super(message);
  }
}

export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
  }
}

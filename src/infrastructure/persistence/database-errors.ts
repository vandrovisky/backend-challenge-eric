import {
  ConcurrencyConflictError,
  DuplicateKeyError,
  TransientInfrastructureError,
  type TransientReason,
} from "../../application/errors";

/**
 * SQLSTATEs that mean "try again later, the request itself is fine".
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "08000",
  "08001",
  "08003",
  "08004",
  "08006", // connection exceptions
]);

const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

interface PgLikeError {
  code?: string;
  sqlState?: string;
  constraint?: string;
  name?: string;
  message?: string;
  cause?: unknown;
}

/** Translates driver errors into the application's vocabulary; anything else is rethrown untouched. */
export function translateDatabaseError(error: unknown): unknown {
  if (
    error instanceof DuplicateKeyError ||
    error instanceof ConcurrencyConflictError ||
    error instanceof TransientInfrastructureError
  ) {
    return error;
  }
  const e = error as PgLikeError;
  const state = e?.sqlState ?? e?.code;
  if (state === "23505") return new DuplicateKeyError(e.constraint ?? "unknown");
  if (state && TRANSIENT_SQLSTATES.has(state)) {
    return new TransientInfrastructureError(`database unavailable or contended (${state})`, error, reasonFor(state));
  }
  const causeCode = (e?.cause as PgLikeError | undefined)?.code;
  if (
    (state && TRANSIENT_NETWORK_CODES.has(state)) ||
    (causeCode && TRANSIENT_NETWORK_CODES.has(causeCode)) ||
    e?.name === "ConnectionException" ||
    /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(e?.message ?? "")
  ) {
    return new TransientInfrastructureError("database connection failure", error, "connection");
  }
  return error;
}

function reasonFor(state: string): TransientReason {
  if (state === "55P03") return "lock_timeout";
  if (state === "40P01") return "deadlock";
  if (state === "40001") return "serialization";
  if (state === "57014") return "timeout";
  if (state.startsWith("08") || state.startsWith("57P") || state.startsWith("53")) return "connection";
  return "other";
}

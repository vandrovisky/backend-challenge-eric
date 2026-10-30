import type { AppLogger, LogFields } from "../../application/ports/observability";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names that must never reach the logs (financial payloads / balances / raw bodies / secrets). */
const REDACTED_KEY = /amount|balance|money|payload|body|authorization|token|secret|password|difference/i;
/** Decimal amounts inside free text (e.g. a DB trigger message "balance 975.00 at version 3"). */
const DECIMAL_IN_TEXT = /-?\b\d+\.\d{1,2}\b/g;
/** Postgres "Key (col)=(values)" details echo row values. */
const PG_KEY_DETAIL = /\(([^()]*)\)=\(([^()]*)\)/g;
const MAX_TEXT = 500;

/** Scrubs a free-text value (error messages) so it cannot leak amounts or row contents. */
export function sanitizeText(text: string): string {
  return text.replace(PG_KEY_DETAIL, "($1)=([redacted])").replace(DECIMAL_IN_TEXT, "[amount]").slice(0, MAX_TEXT);
}

/**
 * One JSON object per line on stdout. Values are scalars only. Sensitive keys are redacted and
 * free text in `err` / `reason` is scrubbed — the log is not an audit trail; the database is.
 */
export class JsonLogger implements AppLogger {
  constructor(
    private readonly base: LogFields = {},
    private readonly minLevel: Level = (process.env.LOG_LEVEL as Level) ?? "info",
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  debug(msg: string, fields?: LogFields) {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields) {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields) {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields & { err?: string }) {
    this.write("error", msg, fields);
  }

  child(fields: LogFields): AppLogger {
    return new JsonLogger({ ...this.base, ...fields }, this.minLevel, this.sink);
  }

  private write(level: Level, msg: string, fields?: LogFields) {
    if (ORDER[level] < (ORDER[this.minLevel] ?? ORDER.info)) return;
    const record: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
    for (const [k, v] of Object.entries({ ...this.base, ...fields })) {
      if (v === undefined || v === null) continue;
      if (REDACTED_KEY.test(k)) record[k] = "[redacted]";
      else if (typeof v === "string" && (k === "err" || k === "reason" || k === "error")) record[k] = sanitizeText(v);
      else record[k] = v;
    }
    this.sink(JSON.stringify(record));
  }
}

export const silentLogger: AppLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

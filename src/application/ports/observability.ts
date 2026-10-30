export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type LogFields = Record<string, string | number | boolean | undefined | null>;

/** Structured logger. Callers pass identifiers only — never amounts, balances or raw payloads. */
export interface AppLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields & { err?: string }): void;
  child(fields: LogFields): AppLogger;
}

export type Labels = Record<string, string>;

export interface Metrics {
  increment(name: string, labels?: Labels, by?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
  gauge(name: string, value: number, labels?: Labels): void;
}

export const noopMetrics: Metrics = { increment() {}, observe() {}, gauge() {} };

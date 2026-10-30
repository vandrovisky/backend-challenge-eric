import { DEFAULT_DATABASE_URL } from "./infrastructure/persistence/mikro-orm.config";

/** All runtime configuration, read once from the environment. */
export interface AppConfig {
  port: number;
  /** Serve Swagger UI at /docs and the OpenAPI document at /docs-json. */
  swaggerEnabled: boolean;
  databaseUrl: string;
  dbPoolMax: number;
  /** Max wait for a wallet row lock before failing transiently (Postgres lock_timeout). */
  dbLockTimeoutMs: number;
  dbStatementTimeoutMs: number;
  sqs: {
    endpoint?: string;
    region: string;
    inputQueueName: string;
    dlqName: string;
    eventsQueueName: string;
    /** How long a received message stays invisible; must exceed worst-case handling time. */
    visibilityTimeoutSeconds: number;
    waitTimeSeconds: number;
    maxAttempts: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    swaggerEnabled: (env.SWAGGER_ENABLED ?? "true") !== "false",
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    dbPoolMax: Number(env.DB_POOL_MAX ?? 10),
    dbLockTimeoutMs: Number(env.DB_LOCK_TIMEOUT_MS ?? 5_000),
    dbStatementTimeoutMs: Number(env.DB_STATEMENT_TIMEOUT_MS ?? 15_000),
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
      region: env.AWS_REGION ?? "us-east-1",
      inputQueueName: env.SQS_INPUT_QUEUE ?? "wager-transactions.fifo",
      dlqName: env.SQS_DLQ ?? "wager-transactions-dlq.fifo",
      eventsQueueName: env.SQS_EVENTS_QUEUE ?? "wager-events.fifo",
      visibilityTimeoutSeconds: Number(env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30),
      waitTimeSeconds: Number(env.SQS_WAIT_TIME_SECONDS ?? 5),
      maxAttempts: Number(env.SQS_MAX_ATTEMPTS ?? 5),
    },
  };
}

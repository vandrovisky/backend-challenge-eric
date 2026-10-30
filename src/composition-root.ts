import { MikroORM } from "@mikro-orm/postgresql";
import type { AppLogger, Clock, Metrics } from "./application/ports/observability";
import { systemClock } from "./application/ports/observability";
import type { TransactionRunner } from "./application/ports/persistence";
import { WalletQueries } from "./application/queries/wallet-queries";
import { ReprocessPendingReferences } from "./application/wagering/reprocess-pending-references";
import { SubmitWagerTransaction } from "./application/wagering/submit-wager-transaction";
import { WagerTransactionApplier } from "./application/wagering/wager-transaction-applier";
import { PublishOutbox } from "./application/outbox/publish-outbox";
import { OpenWallet } from "./application/wallets/open-wallet";
import { loadConfig, type AppConfig } from "./config";
import { ReferenceRetryPolicy } from "./domain/wagering/reference-retry-policy";
import { WagerProcessor } from "./domain/wagering/wager-processor";
import { createSqsClient, QueueUrls } from "./infrastructure/messaging/sqs-client";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event-publisher";
import { GaugeSampler } from "./infrastructure/observability/gauge-sampler";
import { HealthService, PostgresHealthIndicator, SqsHealthIndicator } from "./infrastructure/observability/health";
import { JsonLogger } from "./infrastructure/observability/json-logger";
import { MetricsRegistry } from "./infrastructure/observability/metrics-registry";
import { buildOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmTransactionRunner } from "./infrastructure/persistence/mikro-orm-transaction-runner";
import {
  type ConsumerOptions,
  DEFAULT_CONSUMER_OPTIONS,
  WagerMessageConsumer,
} from "./interfaces/sqs/wager-message-consumer";

export interface CoreOptions {
  config?: Partial<AppConfig>;
  poolMax?: number;
  clock?: Clock;
  logger?: AppLogger;
  metrics?: MetricsRegistry;
  referenceRetryPolicy?: ReferenceRetryPolicy;
  /** Lets tests wrap the runner (e.g. to inject failures). */
  wrapRunner?: (runner: TransactionRunner) => TransactionRunner;
  /** Test seam for the outbox relay (simulate a crash between publish and commit). */
  outboxHooks?: { afterPublish?: () => Promise<void> };
}

/** Plain wiring of the application core, shared by the Nest module, workers and tests. */
export async function createCore(opts: CoreOptions = {}) {
  const base = loadConfig();
  const config: AppConfig = { ...base, ...opts.config, sqs: { ...base.sqs, ...opts.config?.sqs } };
  const ormConfig = buildOrmConfig(config.databaseUrl);
  const orm = await MikroORM.init({
    ...ormConfig,
    pool: { ...ormConfig.pool, max: opts.poolMax ?? config.dbPoolMax },
  });

  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? new JsonLogger({ service: "wagering", instance: process.env.HOSTNAME ?? "local" });
  const metrics = opts.metrics ?? new MetricsRegistry();
  const baseRunner = new MikroOrmTransactionRunner(orm, {
    lockTimeoutMs: config.dbLockTimeoutMs,
    statementTimeoutMs: config.dbStatementTimeoutMs,
  });
  const runner = opts.wrapRunner ? opts.wrapRunner(baseRunner) : baseRunner;
  const applier = new WagerTransactionApplier(
    new WagerProcessor(opts.referenceRetryPolicy ?? new ReferenceRetryPolicy()),
  );

  const sqs = createSqsClient(config.sqs);
  const queueUrls = new QueueUrls(sqs);
  const health = new HealthService([
    new PostgresHealthIndicator(orm),
    new SqsHealthIndicator(sqs, queueUrls, config.sqs.inputQueueName),
  ]);

  const eventPublisher = new SqsEventPublisher(sqs, queueUrls, config.sqs.eventsQueueName);
  const submitWager = new SubmitWagerTransaction(runner, applier, clock, logger, metrics);

  return {
    config,
    orm,
    runner,
    clock,
    logger,
    metrics,
    sqs,
    queueUrls,
    health,
    openWallet: new OpenWallet(runner, clock, logger, metrics),
    submitWager,
    publishOutbox: new PublishOutbox(runner, eventPublisher, clock, logger, metrics, opts.outboxHooks),
    createConsumer: (overrides: Partial<ConsumerOptions> = {}) =>
      new WagerMessageConsumer(sqs, queueUrls, submitWager, logger, metrics, {
        ...DEFAULT_CONSUMER_OPTIONS,
        queueName: config.sqs.inputQueueName,
        dlqName: config.sqs.dlqName,
        visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
        waitTimeSeconds: config.sqs.waitTimeSeconds,
        maxAttempts: config.sqs.maxAttempts,
        ...overrides,
      }),
    reprocessPendingReferences: new ReprocessPendingReferences(runner, applier, clock, logger, metrics),
    queries: new WalletQueries(runner, logger, metrics),
    sampler: new GaugeSampler(orm, sqs, queueUrls, config.sqs.dlqName, metrics),
    async close() {
      sqs.destroy();
      await orm.close();
    },
  };
}

export type Core = Awaited<ReturnType<typeof createCore>>;

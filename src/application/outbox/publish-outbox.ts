import type { EventPublisher } from "../ports/messaging";
import type { AppLogger, Clock, Metrics } from "../ports/observability";
import type { TransactionRunner } from "../ports/persistence";

export interface PublishSummary {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Transactional-outbox relay. Each run claims a batch with FOR UPDATE SKIP LOCKED, publishes it, and
 * marks the outcome — all inside one SQL transaction that holds the row locks:
 *
 *  - concurrent publishers never take the same rows (SKIP LOCKED);
 *  - if this process dies after publishing but before COMMIT, the marks roll back and another publisher
 *    sends the batch again → duplicates are possible, losses are not. Consumers dedupe by eventId;
 *  - a failed publish is rescheduled with exponential backoff (OutboxMessage.scheduleRetry).
 */
export class PublishOutbox {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly hooks: { afterPublish?: () => Promise<void> } = {},
  ) {}

  async runOnce(batchSize = 50): Promise<PublishSummary> {
    const summary = await this.runner.run(async (repos) => {
      const now = this.clock.now();
      const batch = await repos.outbox.claimDue(now, batchSize);
      if (batch.length === 0) return { claimed: 0, published: 0, failed: 0 };

      const results = await this.publisher.publish(batch);
      await this.hooks.afterPublish?.(); // test seam: simulate a crash between publish and commit
      const byId = new Map(results.map((r) => [r.id, r]));

      let published = 0;
      let failed = 0;
      for (const message of batch) {
        const result = byId.get(message.id);
        if (result?.ok) {
          message.markPublished(now);
          await repos.outbox.markPublished(message);
          published += 1;
        } else {
          message.scheduleRetry(now);
          await repos.outbox.scheduleRetry(message, result?.error ?? "no result");
          failed += 1;
          this.logger.warn("outbox publish failed", {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            err: result?.error,
          });
        }
      }
      return { claimed: batch.length, published, failed };
    });

    if (summary.published) this.metrics.increment("outbox_published_total", {}, summary.published);
    if (summary.failed) this.metrics.increment("outbox_publish_failures_total", {}, summary.failed);
    return summary;
  }
}

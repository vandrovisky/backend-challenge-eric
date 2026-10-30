import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Metrics } from "../../application/ports/observability";
import type { QueueUrls } from "../messaging/sqs-client";

export interface GaugeSample {
  outboxPending: number;
  outboxLagMs: number;
  pendingReferences: number;
  dlqDepth: number | null;
}

/**
 * Samples system-wide state that no single request observes: outbox backlog and lag, parked
 * transactions, DLQ depth. Every instance samples (cheap indexed queries); dashboards take max().
 */
export class GaugeSampler {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly urls: QueueUrls,
    private readonly dlqName: string,
    private readonly metrics: Metrics,
  ) {}

  async sample(now = new Date()): Promise<GaugeSample> {
    const em = this.orm.em.fork();
    const [outbox] = await em.execute<{ pending: number; oldest: Date | string | null }[]>(
      `SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );
    const [refs] = await em.execute<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
    );
    const outboxLagMs = outbox?.oldest ? Math.max(0, now.getTime() - new Date(outbox.oldest).getTime()) : 0;

    let dlqDepth: number | null = null;
    try {
      const r = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.urls.get(this.dlqName),
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      dlqDepth = Number(r.Attributes?.ApproximateNumberOfMessages ?? 0);
    } catch {
      // broker unreachable: leave the previous gauge value; readiness reports the outage
    }

    this.metrics.gauge("outbox_pending", outbox?.pending ?? 0);
    this.metrics.gauge("outbox_lag_ms", outboxLagMs);
    this.metrics.gauge("pending_references", refs?.n ?? 0);
    if (dlqDepth !== null) this.metrics.gauge("sqs_dlq_depth", dlqDepth);
    return { outboxPending: outbox?.pending ?? 0, outboxLagMs, pendingReferences: refs?.n ?? 0, dlqDepth };
  }
}

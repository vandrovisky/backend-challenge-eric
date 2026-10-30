import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  IdempotencyConflictError,
  PayloadValidationError,
  PermanentProcessingError,
} from "../../application/errors";
import type { AppLogger, Metrics } from "../../application/ports/observability";
import type { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import type { QueueUrls } from "../../infrastructure/messaging/sqs-client";

export interface ConsumerOptions {
  consumerName: string;
  queueName: string;
  dlqName: string;
  /** Receives before a still-failing (transient) message is moved to the DLQ. */
  maxAttempts: number;
  waitTimeSeconds: number;
  batchSize: number;
  /** Visibility timeout requested on receive; must exceed worst-case processing time. */
  visibilityTimeoutSeconds: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  /** Test seam: runs after the use case committed, before the ack (simulate a crash there). */
  beforeAck?: (message: Message) => Promise<void>;
}

export const DEFAULT_CONSUMER_OPTIONS: Omit<ConsumerOptions, "queueName" | "dlqName"> = {
  consumerName: "wager-transactions-consumer",
  maxAttempts: 5,
  waitTimeSeconds: 5,
  batchSize: 10,
  visibilityTimeoutSeconds: 30,
  backoffBaseSeconds: 2,
  backoffMaxSeconds: 120,
};

/** What to do with a message after handling it. */
type Disposition =
  | { kind: "ack"; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "dlq"; reason: string };

interface Envelope {
  messageId: string;
  type: string;
  occurredAt?: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

class MalformedMessageError extends Error {}

function parseEnvelope(body: string | undefined): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    throw new MalformedMessageError("body is not JSON");
  }
  const e = parsed as Partial<Envelope>;
  if (!e || typeof e !== "object") throw new MalformedMessageError("body is not an object");
  if (typeof e.messageId !== "string" || e.messageId.length === 0 || e.messageId.length > 255) {
    throw new MalformedMessageError("messageId missing or invalid");
  }
  if (e.type !== "WagerTransactionRequested") throw new MalformedMessageError(`unsupported type ${String(e.type)}`);
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) throw new MalformedMessageError("data missing");
  return e as Envelope;
}

/**
 * SQS consumer for `wager-transactions.fifo`. Reuses the SAME use case as the HTTP endpoint, with the
 * inbox enabled so redeliveries are deduplicated by (consumerName, messageId) inside the financial
 * SQL transaction.
 *
 * Error policy:
 *   business outcome (PROCESSED / REJECTED / PENDING_REFERENCE / FAILED replay) → ack
 *   invalid payload, idempotency conflict, permanent processing error, malformed → DLQ (then ack)
 *   transient (DB/broker down, lock timeout) → leave un-acked, push visibility out (exp. backoff);
 *                                               after `maxAttempts` receives → DLQ
 *
 * The ack (DeleteMessage) happens strictly AFTER the use case returned, i.e. after COMMIT. A crash
 * between commit and ack just causes a redelivery, which the inbox turns into a replay.
 */
export class WagerMessageConsumer {
  private running = false;
  private loop?: Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly urls: QueueUrls,
    private readonly submit: SubmitWagerTransaction,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly opts: ConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info("sqs consumer started", { queue: this.opts.queueName, consumer: this.opts.consumerName });
  }

  /**
   * Graceful stop (SIGTERM): stop polling, let in-flight messages finish (they ack normally).
   * The current long poll is NOT aborted — aborting could drop messages SQS already handed us
   * (they would stay invisible until the timeout). It returns within `waitTimeSeconds`, and anything
   * it brought back is released with visibility 0 instead of being processed.
   */
  async stop(timeoutMs = 20_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const drained = Promise.allSettled([this.loop, ...this.inFlight]);
    await Promise.race([drained, Bun.sleep(timeoutMs)]);
    this.logger.info("sqs consumer stopped", { queue: this.opts.queueName });
  }

  /** Receives and handles one batch. Exposed for deterministic tests. */
  async pollOnce(): Promise<number> {
    const queueUrl = await this.urls.get(this.opts.queueName);
    const out = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: this.opts.batchSize,
        WaitTimeSeconds: this.opts.waitTimeSeconds,
        VisibilityTimeout: this.opts.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );
    const messages = out.Messages ?? [];
    if (messages.length === 0) return 0;

    // FIFO: keep order within a message group, run different groups in parallel.
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? "default";
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (let i = 0; i < group.length; i++) {
          const message = group[i]!;
          if (this.stopping()) {
            // shutting down: give the rest of the group back to the queue untouched
            await Promise.all(group.slice(i).map((m) => this.release(queueUrl, m)));
            return;
          }
          const work = this.handle(queueUrl, message);
          this.inFlight.add(work);
          try {
            await work;
          } finally {
            this.inFlight.delete(work);
          }
        }
      }),
    );
    return messages.length;
  }

  /** True once stop() was called on a started consumer (pollOnce used directly is never "stopping"). */
  private stopping(): boolean {
    return !this.running && this.loop !== undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.metrics.increment("sqs_receive_errors_total");
        this.logger.error("sqs receive failed", { queue: this.opts.queueName, err: (e as Error).message });
        if (this.running) await Bun.sleep(1_000);
      }
    }
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const started = performance.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const log = this.logger.child({ sqsMessageId: message.MessageId, receiveCount });
    let disposition: Disposition;
    let envelope: Envelope | undefined;

    try {
      envelope = parseEnvelope(message.Body);
      const data = envelope.data;
      const result = await this.submit.execute(
        {
          idempotencyKey: data.idempotencyKey,
          providerId: data.providerId,
          externalTransactionId: data.externalTransactionId,
          playerId: data.playerId,
          walletId: data.walletId,
          roundId: data.roundId,
          gameId: data.gameId,
          kind: data.kind,
          money: data.money,
          referenceExternalTransactionId: data.referenceExternalTransactionId,
        },
        {
          correlationId: envelope.correlationId ?? envelope.messageId,
          causationId: envelope.messageId,
          inbox: { consumerName: this.opts.consumerName, messageId: envelope.messageId },
        },
      );
      disposition = { kind: "ack", reason: result.status };
    } catch (error) {
      disposition = this.classify(error, receiveCount);
    }

    const fields = { messageId: envelope?.messageId, disposition: disposition.kind, reason: disposition.reason };
    try {
      if (disposition.kind === "ack") {
        await this.opts.beforeAck?.(message);
        await this.ack(queueUrl, message);
      } else if (disposition.kind === "dlq") {
        await this.toDeadLetter(message, disposition.reason);
        await this.ack(queueUrl, message);
        this.metrics.increment("sqs_dlq_messages_total", { reason: disposition.reason });
        log.warn("message moved to DLQ", fields);
      } else {
        const delay = Math.min(
          this.opts.backoffBaseSeconds * 2 ** (receiveCount - 1),
          this.opts.backoffMaxSeconds,
        );
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: Math.round(delay),
          }),
        );
        this.metrics.increment("sqs_retries_total");
        log.warn("transient failure, message will be redelivered", { ...fields, retryInSeconds: delay });
      }
    } catch (e) {
      // Ack/visibility failures are safe: the message comes back and the inbox dedupes it.
      this.metrics.increment("sqs_ack_errors_total");
      log.error("failed to settle message", { ...fields, err: (e as Error).message });
    }
    this.metrics.observe("sqs_message_handling_ms", Math.round(performance.now() - started), {
      disposition: disposition.kind,
    });
  }

  private classify(error: unknown, receiveCount: number): Disposition {
    if (error instanceof MalformedMessageError) return { kind: "dlq", reason: "MALFORMED_MESSAGE" };
    if (error instanceof PayloadValidationError) return { kind: "dlq", reason: error.code };
    if (error instanceof IdempotencyConflictError) return { kind: "dlq", reason: error.code };
    if (error instanceof PermanentProcessingError) return { kind: "dlq", reason: error.code };
    // Everything else is treated as transient: retrying is safe thanks to the inbox.
    if (receiveCount >= this.opts.maxAttempts) return { kind: "dlq", reason: "MAX_ATTEMPTS_EXCEEDED" };
    return { kind: "retry", reason: error instanceof Error ? error.name : "unknown" };
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
  }

  private async release(queueUrl: string, message: Message): Promise<void> {
    await this.sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      )
      .catch(() => undefined);
  }

  private async toDeadLetter(message: Message, reason: string): Promise<void> {
    const dlqUrl = await this.urls.get(this.opts.dlqName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: reason },
          originalMessageId: { DataType: "String", StringValue: message.MessageId ?? "unknown" },
        },
      }),
    );
  }
}

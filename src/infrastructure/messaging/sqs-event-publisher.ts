import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher, PublishResult } from "../../application/ports/messaging";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { QueueUrls } from "./sqs-client";

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox events to a FIFO queue.
 *  - MessageGroupId = aggregateId → events of one wallet/transaction stay ordered;
 *  - MessageDeduplicationId = eventId → the broker drops re-publications inside its 5-min window.
 *    That is an optimisation only: consumers must still dedupe by eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly urls: QueueUrls,
    private readonly queueName: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    let queueUrl: string;
    try {
      queueUrl = await this.urls.get(this.queueName);
    } catch (e) {
      return messages.map((m) => ({ id: m.id, ok: false, error: errorText(e) }));
    }

    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const out = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m, idx) => ({
              Id: String(idx),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: "String", StringValue: m.eventType } },
            })),
          }),
        );
        const failed = new Map((out.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? "failed"]));
        chunk.forEach((m, idx) => {
          const err = failed.get(String(idx));
          results.push(err ? { id: m.id, ok: false, error: err } : { id: m.id, ok: true });
        });
      } catch (e) {
        for (const m of chunk) results.push({ id: m.id, ok: false, error: errorText(e) });
      }
    }
    return results;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

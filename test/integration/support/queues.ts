import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { loadConfig } from "../../../src/config";
import { newId } from "../../../src/domain/shared/id";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs-client";

export function testSqsClient(): SQSClient {
  return createSqsClient(loadConfig().sqs);
}

export interface TestQueues {
  inputQueueName: string;
  dlqName: string;
  eventsQueueName: string;
}

/** Fresh FIFO queues per test, so tests never see each other's messages. */
export async function createTestQueues(sqs: SQSClient): Promise<TestQueues> {
  const suffix = newId().replace(/-/g, "").slice(-16);
  const names = {
    inputQueueName: `t-in-${suffix}.fifo`,
    dlqName: `t-dlq-${suffix}.fifo`,
    eventsQueueName: `t-ev-${suffix}.fifo`,
  };
  for (const name of Object.values(names)) {
    await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", VisibilityTimeout: "30" },
      }),
    );
  }
  return names;
}

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
}

export interface WagerEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function envelope(data: Record<string, unknown>, messageId = `msg-${newId()}`): WagerEnvelope {
  return { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data };
}

/** Sends a raw body; each send gets its own SQS dedup id so a "redelivery" can be simulated on purpose. */
export async function sendRaw(sqs: SQSClient, name: string, body: string, groupId = "g"): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(sqs, name),
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: newId(),
    }),
  );
}

export async function send(sqs: SQSClient, name: string, env: WagerEnvelope, groupId?: string): Promise<void> {
  await sendRaw(sqs, name, JSON.stringify(env), groupId ?? String(env.data.walletId ?? "g"));
}

/** Receives (and deletes) everything currently in a queue. */
export async function drain(
  sqs: SQSClient,
  name: string,
): Promise<Array<{ body: string; attributes: Record<string, string | undefined> }>> {
  const url = await queueUrl(sqs, name);
  const out: Array<{ body: string; attributes: Record<string, string | undefined> }> = [];
  for (let empty = 0; empty < 2; ) {
    const r = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    const messages = r.Messages ?? [];
    if (messages.length === 0) {
      empty += 1;
      continue;
    }
    for (const m of messages) {
      out.push({
        body: m.Body ?? "",
        attributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue]),
        ),
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return out;
}

export async function approximateCount(sqs: SQSClient, name: string): Promise<number> {
  const r = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(sqs, name),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return (
    Number(r.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

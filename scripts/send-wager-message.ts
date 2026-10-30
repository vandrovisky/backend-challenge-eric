import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../src/config";
import { newId } from "../src/domain/shared/id";
import { createSqsClient, QueueUrls } from "../src/infrastructure/messaging/sqs-client";

/**
 * Publishes WagerTransactionRequested messages to the input queue.
 *
 *   bun run scripts/send-wager-message.ts --wallet <id> --player <id> [--kind BET] [--amount 10.00]
 *        [--count 1] [--ref <externalId>] [--ext <externalId>] [--duplicate]
 *
 * --duplicate sends every message twice with the same messageId (simulates broker redelivery).
 */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const walletId = arg("wallet");
const playerId = arg("player");
if (!walletId || !playerId) {
  console.error("usage: --wallet <uuid> --player <uuid> [--kind BET] [--amount 10.00] [--count 1] [--ref id] [--duplicate]");
  process.exit(1);
}
const kind = arg("kind", "BET")!;
const amount = arg("amount", "10.00")!;
const count = Number(arg("count", "1"));
const duplicate = process.argv.includes("--duplicate");

const config = loadConfig();
const sqs = createSqsClient(config.sqs);
const queueUrl = await new QueueUrls(sqs).get(config.sqs.inputQueueName);

for (let i = 0; i < count; i++) {
  const externalTransactionId = count === 1 ? (arg("ext") ?? `tx-${newId()}`) : `tx-${newId()}`;
  const envelope = {
    messageId: `msg-${newId()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId,
      walletId,
      roundId: "round-cli",
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
      ...(arg("ref") ? { referenceExternalTransactionId: arg("ref") } : {}),
    },
  };
  for (let copy = 0; copy < (duplicate ? 2 : 1); copy++) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: newId(), // distinct per send, so duplicates really reach the consumer
      }),
    );
  }
  console.log(`sent ${envelope.messageId} ${kind} ${amount} ext=${externalTransactionId}${duplicate ? " (x2)" : ""}`);
}
sqs.destroy();

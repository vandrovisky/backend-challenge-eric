import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { createCore, type Core, type CoreOptions } from "../../src/composition-root";
import { newId } from "../../src/domain/shared/id";
import { silentLogger } from "../../src/infrastructure/observability/json-logger";
import type { ConsumerOptions } from "../../src/interfaces/sqs/wager-message-consumer";
import { connect, resetDatabase } from "./support/database";
import { brl, expectWalletConsistent, openWallet, wager } from "./support/fixtures";
import { approximateCount, createTestQueues, drain, envelope, send, sendRaw, testSqsClient, type TestQueues } from "./support/queues";

let sql: SQL;
let sqs: SQSClient;
const cores: Core[] = [];

beforeAll(async () => {
  await resetDatabase();
  sql = connect();
  sqs = testSqsClient();
});

afterAll(async () => {
  await Promise.all(cores.map((c) => c.close().catch(() => undefined)));
  await sql?.close();
  sqs?.destroy();
});

async function makeCore(queues: TestQueues, opts: CoreOptions = {}): Promise<Core> {
  const core = await createCore({
    poolMax: 10,
    logger: silentLogger,
    ...opts,
    config: { ...opts.config, sqs: { ...queues, ...opts.config?.sqs } as never },
  });
  cores.push(core);
  return core;
}

const FAST: Partial<ConsumerOptions> = { waitTimeSeconds: 1, visibilityTimeoutSeconds: 2, backoffBaseSeconds: 0 };

/** Polls until the queue yields nothing `idleRounds` times in a row. */
async function consumeAll(core: Core, overrides: Partial<ConsumerOptions> = {}, idleRounds = 2) {
  const consumer = core.createConsumer({ ...FAST, ...overrides });
  let handled = 0;
  for (let idle = 0; idle < idleRounds; ) {
    const n = await consumer.pollOnce();
    handled += n;
    idle = n === 0 ? idle + 1 : 0;
  }
  return handled;
}

function messageData(cmd: ReturnType<typeof wager>) {
  return { ...cmd } as Record<string, unknown>;
}

async function txStatus(idempotencyKey: string) {
  return sql`SELECT id, status, failure_code FROM wager_transactions WHERE idempotency_key = ${idempotencyKey}`;
}

describe("SQS consumer", () => {
  test("processes a message through the same use case, records the inbox and acks after commit", async () => {
    const queues = await createTestQueues(sqs);
    const core = await makeCore(queues);
    const w = await openWallet(core, "100.00");
    const cmd = wager(w, "BET", "25.00");
    const env = envelope(messageData(cmd));
    await send(sqs, queues.inputQueueName, env);

    expect(await consumeAll(core)).toBe(1);
    const rows = await txStatus(cmd.idempotencyKey as string);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PROCESSED");
    const [inbox] = await sql`SELECT processed_at IS NOT NULL AS done, transaction_id FROM inbox_messages WHERE message_id = ${env.messageId}`;
    expect(inbox).toEqual({ done: true, transaction_id: rows[0].id });
    expect(await approximateCount(sqs, queues.inputQueueName)).toBe(0);
    await expectWalletConsistent(sql, w.walletId, "75.00");
  });

  test("redelivery of the same messageId (and a resend under a new messageId) has a single effect", async () => {
    const queues = await createTestQueues(sqs);
    const core = await makeCore(queues);
    const w = await openWallet(core, "100.00");
    const cmd = wager(w, "BET", "10.00");
    const env = envelope(messageData(cmd));
    await send(sqs, queues.inputQueueName, env);
    await send(sqs, queues.inputQueueName, env); // broker-level duplicate
    await send(sqs, queues.inputQueueName, envelope(messageData(cmd))); // provider resend, new messageId

    expect(await consumeAll(core)).toBe(3);
    expect(await txStatus(cmd.idempotencyKey as string)).toHaveLength(1);
    expect(core.metrics.counter("wager_duplicates_total", { source: "sqs" })).toBe(2);
    await expectWalletConsistent(sql, w.walletId, "90.00");
  });

  test("business rejection is acked (terminal), not dead-lettered", async () => {
    const queues = await createTestQueues(sqs);
    const core = await makeCore(queues);
    const w = await openWallet(core, "5.00");
    const cmd = wager(w, "BET", "50.00");
    await send(sqs, queues.inputQueueName, envelope(messageData(cmd)));
    await consumeAll(core);
    expect((await txStatus(cmd.idempotencyKey as string))[0]).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await approximateCount(sqs, queues.dlqName)).toBe(0);
  });

  test("invalid payload, malformed JSON and idempotency conflicts go to the DLQ with a reason", async () => {
    const queues = await createTestQueues(sqs);
    const core = await makeCore(queues);
    const w = await openWallet(core, "100.00");
    const ok = wager(w, "BET", "1.00");
    await send(sqs, queues.inputQueueName, envelope(messageData(ok)));
    await consumeAll(core);

    await send(sqs, queues.inputQueueName, envelope({ ...messageData(wager(w, "BET", "1.00")), money: { amount: 1, currency: "BRL" } }));
    await sendRaw(sqs, queues.inputQueueName, "{not json");
    await send(sqs, queues.inputQueueName, envelope({ ...messageData(ok), money: brl("2.00") })); // same key, other payload
    await consumeAll(core);

    const dead = await drain(sqs, queues.dlqName);
    expect(dead.map((d) => d.attributes.failureReason).sort()).toEqual([
      "IDEMPOTENCY_CONFLICT",
      "INVALID_PAYLOAD",
      "MALFORMED_MESSAGE",
    ]);
    expect(await approximateCount(sqs, queues.inputQueueName)).toBe(0);
    expect(core.metrics.counter("sqs_dlq_messages_total", { reason: "INVALID_PAYLOAD" })).toBe(1);
    await expectWalletConsistent(sql, w.walletId, "99.00");
  });

  test("worker dies after COMMIT and before ACK: redelivery becomes a replay, one effect", async () => {
    const queues = await createTestQueues(sqs);
    const crashing = await makeCore(queues);
    const w = await openWallet(crashing, "100.00");
    const cmd = wager(w, "BET", "40.00");
    const env = envelope(messageData(cmd));
    await send(sqs, queues.inputQueueName, env);

    // First worker commits, then "dies" before deleting the message.
    const dying = crashing.createConsumer({
      ...FAST,
      visibilityTimeoutSeconds: 1,
      beforeAck: async () => {
        throw new Error("process killed before ack");
      },
    });
    expect(await dying.pollOnce()).toBe(1);
    expect((await txStatus(cmd.idempotencyKey as string))[0].status).toBe("PROCESSED");
    expect(await approximateCount(sqs, queues.inputQueueName)).toBe(1); // still there, invisible

    // Another instance picks it up after the visibility timeout.
    const survivor = await makeCore(queues);
    await Bun.sleep(1_200);
    expect(await consumeAll(survivor)).toBe(1);
    expect(survivor.metrics.counter("wager_duplicates_total", { source: "sqs" })).toBe(1);
    expect(await approximateCount(sqs, queues.inputQueueName)).toBe(0);
    await expectWalletConsistent(sql, w.walletId, "60.00");
  });

  test("transient failures are retried with backoff and dead-lettered after maxAttempts", async () => {
    const queues = await createTestQueues(sqs);
    const broken = await makeCore(queues, {
      config: { databaseUrl: "postgres://wagering:wagering@127.0.0.1:1/wagering" },
    });
    const cmd = wager({ walletId: newId(), playerId: newId() }, "BET", "1.00");
    await send(sqs, queues.inputQueueName, envelope(messageData(cmd)));

    const handled = await consumeAll(broken, { maxAttempts: 3 }, 3);
    expect(handled).toBe(3); // received 3 times: retry, retry, DLQ
    expect(broken.metrics.counter("sqs_retries_total")).toBe(2);
    const dead = await drain(sqs, queues.dlqName);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attributes.failureReason).toBe("MAX_ATTEMPTS_EXCEEDED");
    expect(await approximateCount(sqs, queues.inputQueueName)).toBe(0);
  });

  test("graceful stop: in-flight work completes, nothing is lost or duplicated", async () => {
    const queues = await createTestQueues(sqs);
    const core = await makeCore(queues);
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(core, "100.00")));
    const cmds = wallets.flatMap((w) => Array.from({ length: 4 }, () => wager(w, "BET", "5.00")));
    for (const c of cmds) await send(sqs, queues.inputQueueName, envelope(messageData(c)));

    const consumer = core.createConsumer({ ...FAST, batchSize: 3 });
    consumer.start();
    await Bun.sleep(300);
    await consumer.stop(); // SIGTERM while messages are in flight

    // A new instance drains whatever is left (released messages are visible again immediately).
    const next = await makeCore(queues);
    await consumeAll(next);
    for (const w of wallets) await expectWalletConsistent(sql, w.walletId, "80.00");
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key IN ${sql(cmds.map((c) => c.idempotencyKey as string))}`;
    expect(n).toBe(cmds.length);
  });
});

describe("transactional outbox", () => {
  async function eventsInQueue(queues: TestQueues) {
    return (await drain(sqs, queues.eventsQueueName)).map((m) => JSON.parse(m.body) as { eventId: string; eventType: string });
  }

  test("committed events are published after commit and marked published; lag returns to 0", async () => {
    const queues = await createTestQueues(sqs);
    const core = await makeCore(queues);
    const w = await openWallet(core, "100.00");
    const r = await core.submitWager.execute(wager(w, "BET", "10.00"), { correlationId: "c-outbox" });

    let published = 0;
    for (let s = await core.publishOutbox.runOnce(); s.claimed > 0; s = await core.publishOutbox.runOnce()) {
      published += s.published;
    }
    expect(published).toBeGreaterThanOrEqual(2);
    const sample = await core.sampler.sample();
    expect(sample.outboxPending).toBe(0);
    expect(core.metrics.render()).toContain("outbox_lag_ms 0");
    const events = await eventsInQueue(queues);
    const forTx = events.filter((e) => (e as { aggregateId?: string }).aggregateId === r.transactionId);
    expect(forTx.map((e) => e.eventType)).toEqual(["WagerTransactionProcessed"]);
    expect(events.some((e) => e.eventType === "WalletBalanceChanged")).toBe(true);

    const [{ pending }] = await sql`SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL AND aggregate_id IN (${w.walletId}, ${r.transactionId})`;
    expect(pending).toBe(0);
  });

  test("process dies after COMMIT and before publishing: another instance publishes later", async () => {
    const queues = await createTestQueues(sqs);
    const first = await makeCore(queues);
    const w = await openWallet(first, "100.00");
    const r = await first.submitWager.execute(wager(w, "BET", "10.00"), { correlationId: "c-crash" });
    await first.close(); // dies: nothing was published

    const second = await makeCore(queues); // "restarted" instance
    while ((await second.publishOutbox.runOnce()).claimed > 0) {}
    const events = await eventsInQueue(queues);
    expect(events.some((e) => (e as { aggregateId?: string }).aggregateId === r.transactionId)).toBe(true);
  });

  test("two concurrent publishers over the same outbox claim disjoint batches (no double publish)", async () => {
    // Start from a fully published outbox so the count below is exact.
    const queues = await createTestQueues(sqs);
    const a = await makeCore(queues);
    const b = await makeCore(queues);
    while ((await a.publishOutbox.runOnce()).claimed > 0) {}
    await drain(sqs, queues.eventsQueueName);

    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(a, "100.00")));
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 3 }, () => a.submitWager.execute(wager(w, "BET", "1.00"), { correlationId: "c" }))));
    const [{ total }] = await sql`SELECT count(*)::int AS total FROM outbox_messages WHERE published_at IS NULL`;
    expect(total).toBe(10 + 30 * 2); // opening + (processed + balance changed) per bet

    let claimedA = 0;
    let claimedB = 0;
    const loop = async (core: Core, add: (n: number) => void) => {
      for (;;) {
        const s = await core.publishOutbox.runOnce(7);
        if (s.claimed === 0) return;
        add(s.claimed);
      }
    };
    await Promise.all([loop(a, (n) => (claimedA += n)), loop(b, (n) => (claimedB += n))]);

    expect(claimedA + claimedB).toBe(total); // every row claimed exactly once across both publishers
    expect(claimedA).toBeGreaterThan(0);
    expect(claimedB).toBeGreaterThan(0);
    const events = await eventsInQueue(queues);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(total);
    expect(events).toHaveLength(total);
  });

  test("crash between publish and commit: the batch is republished (at-least-once), never lost", async () => {
    const queues = await createTestQueues(sqs);
    let crash = true;
    const flaky = await makeCore(queues, {
      outboxHooks: {
        afterPublish: async () => {
          if (crash) throw new Error("killed after SendMessage, before COMMIT");
        },
      },
    });
    while ((await flaky.publishOutbox.runOnce().catch(() => ({ claimed: 0 }))).claimed > 0) {}
    // the loop above stops on the first crash; everything due is still unpublished
    const w = await openWallet(flaky, "100.00");
    await flaky.submitWager.execute(wager(w, "BET", "1.00"), { correlationId: "c" });
    await expect(flaky.publishOutbox.runOnce()).rejects.toThrow("killed after SendMessage");
    const [{ pending }] = await sql`SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`;
    expect(pending).toBeGreaterThan(0);

    crash = false;
    while ((await flaky.publishOutbox.runOnce()).claimed > 0) {}
    const [{ left }] = await sql`SELECT count(*)::int AS left FROM outbox_messages WHERE published_at IS NULL`;
    expect(left).toBe(0);
    // Published twice; the FIFO dedup id (= eventId) collapses it, and consumers dedupe by eventId anyway.
    const events = await eventsInQueue(queues);
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

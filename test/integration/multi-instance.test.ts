import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { newId } from "../../src/domain/shared/id";
import { startInstances, scrapeCounter, type ServiceInstance } from "../support/instances";
import { connect, resetDatabase } from "./support/database";
import { brl } from "./support/fixtures";
import { approximateCount, createTestQueues, drain, envelope, send, testSqsClient, type TestQueues } from "./support/queues";

/**
 * The service as it runs in production: N separate OS processes (HTTP + consumer + outbox relay +
 * reference worker each) sharing one Postgres and one set of SQS queues. Nothing is mocked.
 */
let sql: SQL;
let sqs: SQSClient;
let queues: TestQueues;
let instances: ServiceInstance[] = [];

const BASE_PORT = 3100;
const env = () => ({
  SQS_INPUT_QUEUE: queues.inputQueueName,
  SQS_DLQ: queues.dlqName,
  SQS_EVENTS_QUEUE: queues.eventsQueueName,
  SQS_VISIBILITY_TIMEOUT_SECONDS: "3",
  SQS_WAIT_TIME_SECONDS: "1",
  DB_POOL_MAX: "8",
});

beforeAll(async () => {
  await resetDatabase();
  sql = connect();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  instances = await startInstances(3, BASE_PORT, env());
}, 60_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.kill()));
  await sql?.close();
  sqs?.destroy();
});

// ---------------------------------------------------------------- helpers

let rr = 0;
/** Round-robin across live instances, like a load balancer. */
function pick(): ServiceInstance {
  const live = instances;
  return live[rr++ % live.length]!;
}

async function post(inst: ServiceInstance, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${inst.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function createWallet(amount: string) {
  const playerId = newId();
  const r = await post(pick(), "/wallets", { playerId, initialBalance: brl(amount) });
  expect(r.status).toBe(201);
  return { walletId: r.body.id as string, playerId };
}

function bet(w: { walletId: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? `t-${newId()}`;
  const body = {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "r",
    gameId: "g",
    kind,
    money: brl(amount),
    ...extra,
  };
  return { body, headers: { "Idempotency-Key": body.idempotencyKey } };
}

/** The global invariant, checked for EVERY wallet in the database at once. */
async function expectAllWalletsConsistent() {
  const rows = await sql`
    SELECT w.id, w.balance::text AS balance,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS replay
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`;
  expect(rows).toEqual([]);
  const [{ negative }] = await sql`SELECT count(*)::int AS negative FROM wallets WHERE balance < 0`;
  expect(negative).toBe(0);
}

async function waitFor(what: string, predicate: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const queueEmpty = () => approximateCount(sqs, queues.inputQueueName).then((n) => n === 0);
const outboxDrained = async () => (await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)[0].n === 0;

// ---------------------------------------------------------------- tests

describe("3 instances over HTTP", () => {
  test("the same bet sent 50 times, spread across 3 processes, debits once", async () => {
    const w = await createWallet("100.00");
    const b = bet(w, "BET", "25.00");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => post(pick(), "/wagering/transactions", b.body, b.headers)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    const [{ debits }] = await sql`SELECT count(*)::int AS debits FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId} AND direction = 'DEBIT'`;
    expect(debits).toBe(1);
  });

  test("mandatory scenario with each bet on a different process", async () => {
    const w = await createWallet("100.00");
    const [a, b] = [bet(w, "BET", "80.00"), bet(w, "BET", "80.00")];
    const results = await Promise.all([
      post(instances[0]!, "/wagering/transactions", a.body, a.headers),
      post(instances[1]!, "/wagering/transactions", b.body, b.headers),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const [row] = await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${w.walletId}`;
    expect(row.balance).toBe("20.00");
  });

  test("hot wallet + 20 cold wallets, 400 mixed operations from all processes at once", async () => {
    const hot = await createWallet("500.00");
    const cold = await Promise.all(Array.from({ length: 20 }, () => createWallet("100.00")));
    const ops = [
      ...Array.from({ length: 200 }, (_, i) => bet(hot, i % 4 === 0 ? "WIN" : i % 4 === 3 ? "LOSS" : "BET", "7.00")),
      ...cold.flatMap((w) => Array.from({ length: 10 }, () => bet(w, "BET", "15.00"))),
    ];
    const results = await Promise.all(ops.map((o) => post(pick(), "/wagering/transactions", o.body, o.headers)));
    expect(results.every((r) => [201, 422].includes(r.status))).toBe(true);
    await expectAllWalletsConsistent();
  });
});

describe("3 instances consuming the same queue", () => {
  test("100 messages for 10 wallets, each delivered twice: one effect each", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet("100.00")));
    const msgs = wallets.flatMap((w) => Array.from({ length: 10 }, () => envelope(bet(w, "BET", "5.00").body)));
    for (const m of msgs) {
      await send(sqs, queues.inputQueueName, m);
      await send(sqs, queues.inputQueueName, m); // broker redelivery
    }
    await waitFor("queue drained", queueEmpty);
    for (const w of wallets) {
      const [row] = await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${w.walletId}`;
      expect(row.balance).toBe("50.00");
    }
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id IN ${sql(msgs.map((m) => m.messageId))}`;
    expect(n).toBe(100);
    // every instance took part
    const handledPerInstance = await Promise.all(
      instances.map((i) => scrapeCounter([i], "sqs_message_handling_ms_count")),
    );
    expect(handledPerInstance.filter((c) => c > 0).length).toBeGreaterThanOrEqual(2);
    await expectAllWalletsConsistent();
  });

  test("an instance crashes (SIGKILL) mid-stream: its in-flight messages are redelivered, nothing lost or doubled", async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => createWallet("1000.00")));
    const msgs = wallets.flatMap((w) => Array.from({ length: 10 }, () => envelope(bet(w, "BET", "1.00").body)));
    const sending = (async () => {
      for (const m of msgs) await send(sqs, queues.inputQueueName, m);
    })();
    await Bun.sleep(500);
    await instances[0]!.kill(); // hard crash, no graceful shutdown
    await sending;

    await waitFor("queue drained by the survivors", queueEmpty, 90_000);
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key IN ${sql(msgs.map((m) => m.data.idempotencyKey as string))}`;
    expect(n).toBe(msgs.length);
    for (const w of wallets) {
      const [row] = await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${w.walletId}`;
      expect(row.balance).toBe("990.00");
    }
    await expectAllWalletsConsistent();

    // bring the crashed instance back for the next tests
    await instances[0]!.start();
  }, 120_000);
});

describe("restart with proof of final consistency", () => {
  test("crash after commit with unpublished outbox + queued work + out-of-order reversal → restart converges", async () => {
    // Phase 1: instances that commit financial work but never publish (outbox relay disabled), then crash.
    await Promise.all(instances.map((i) => i.stop()));
    instances = await startInstances(3, BASE_PORT, { ...env(), WORKERS: "consumer,references" });
    await waitFor("previous outbox drained", outboxDrained).catch(() => undefined);
    const w = await createWallet("100.00");
    for (let i = 0; i < 10; i++) {
      const b = bet(w, "BET", "1.00");
      expect((await post(pick(), "/wagering/transactions", b.body, b.headers)).status).toBe(201);
    }
    const [{ unpublished }] = await sql`SELECT count(*)::int AS unpublished FROM outbox_messages WHERE published_at IS NULL`;
    expect(unpublished).toBeGreaterThanOrEqual(21); // opening + 10 × (processed + balance changed)
    await Promise.all(instances.map((i) => i.kill())); // everyone dies after COMMIT, before publishing

    // Phase 2: while the service is down, work keeps arriving on the queue — and out of order.
    const betExt = `late-bet-${newId()}`;
    await send(sqs, queues.inputQueueName, envelope(bet(w, "REFUND", "30.00", { referenceExternalTransactionId: betExt }).body), "g1");
    await send(sqs, queues.inputQueueName, envelope(bet(w, "BET", "30.00", { externalTransactionId: betExt }).body), "g2");
    const [{ total }] = await sql`SELECT count(*)::int AS total FROM outbox_messages`;

    // Phase 3: a fresh deployment comes up with every worker.
    instances = await startInstances(3, BASE_PORT, env());
    await waitFor("queue drained", queueEmpty);
    await waitFor("refund applied", async () => {
      const [r] = await sql`SELECT status FROM wager_transactions WHERE kind = 'REFUND' AND reference_external_transaction_id = ${betExt}`;
      return r?.status === "PROCESSED";
    });
    await waitFor("outbox drained", outboxDrained);

    // Final state: balance = 100 - 10 (bets) - 30 + 30 (bet refunded) = 90, everything published, nothing parked.
    const [row] = await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${w.walletId}`;
    expect(row.balance).toBe("90.00");
    const [{ parked }] = await sql`SELECT count(*)::int AS parked FROM wager_transactions WHERE status IN ('PENDING','PENDING_REFERENCE')`;
    expect(parked).toBe(0);
    const published = await drain(sqs, queues.eventsQueueName);
    const ids = new Set(published.map((m) => (JSON.parse(m.body) as { eventId: string }).eventId));
    expect(ids.size).toBeGreaterThanOrEqual(total); // every committed event reached the broker
    await expectAllWalletsConsistent();

    // Reconciliation endpoint agrees, from any instance.
    const rec = await post(pick(), `/wallets/${w.walletId}/reconciliation`, {});
    expect(rec.body).toMatchObject({ consistent: true, storedBalance: brl("90.00") });

    // Graceful shutdown exits cleanly.
    expect(await Promise.all(instances.map((i) => i.stop()))).toEqual([0, 0, 0]);
  }, 180_000);
});

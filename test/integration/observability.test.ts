import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { SQL } from "bun";
import { TransientInfrastructureError } from "../../src/application/errors";
import { createCore, type Core } from "../../src/composition-root";
import { newId } from "../../src/domain/shared/id";
import { ReferenceRetryPolicy } from "../../src/domain/wagering/reference-retry-policy";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { createHttpApp } from "../../src/interfaces/http/http-app";
import { connect, resetDatabase } from "./support/database";
import { brl, openWallet, wager } from "./support/fixtures";

// Distinctive amounts: if any of these strings shows up in a log line, money leaked into the logs.
const SECRET_AMOUNTS = ["1234.56", "123.45", "1111.11"]; // 1111.11 = 1234.56 - 123.45

let core: Core;
let app: INestApplication;
let base: string;
let sql: SQL;
const logLines: string[] = [];

beforeAll(async () => {
  await resetDatabase();
  core = await createCore({
    poolMax: 10,
    logger: new JsonLogger({ service: "wagering-test" }, "debug", (l) => logLines.push(l)),
    config: { dbLockTimeoutMs: 200 },
    referenceRetryPolicy: new ReferenceRetryPolicy(60_000, 60_000, 3, 0),
  });
  app = await createHttpApp(core);
  await app.listen(0, "127.0.0.1");
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  sql = connect();
});

afterAll(async () => {
  await app?.close();
  await core?.close();
  await sql?.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("structured logs", () => {
  test("carry correlation ids and never contain amounts or balances", async () => {
    const playerId = newId();
    const wallet = await post("/wallets", { playerId, initialBalance: brl("1234.56") }, { "X-Correlation-Id": "corr-logs-1" });
    const ext = `t-${newId()}`;
    const bet = {
      providerId: "provider-a",
      externalTransactionId: ext,
      playerId,
      walletId: wallet.body.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: brl("123.45"),
    };
    await post("/wagering/transactions", bet, { "Idempotency-Key": `provider-a:${ext}`, "X-Correlation-Id": "corr-logs-2" });
    await post("/wagering/transactions", bet, { "Idempotency-Key": `provider-a:${ext}` }); // replay
    await post("/wallets/" + wallet.body.id + "/reconciliation", {});

    const records = logLines.map((l) => JSON.parse(l) as Record<string, unknown>); // every line is valid JSON
    const handled = records.find((r) => r.msg === "wager transaction handled" && r.correlationId === "corr-logs-2");
    expect(handled).toMatchObject({
      correlationId: "corr-logs-2",
      providerId: "provider-a",
      walletId: wallet.body.id,
      transactionId: expect.any(String),
      status: "PROCESSED",
    });
    const httpLine = records.find((r) => r.msg === "http request" && r.correlationId === "corr-logs-2");
    expect(httpLine).toMatchObject({ method: "POST", route: "/wagering/transactions", status: 201 });

    const all = logLines.join("\n");
    for (const amount of SECRET_AMOUNTS) expect(all).not.toContain(amount);
    expect(all).not.toContain('"money"');
  });
});

describe("metrics", () => {
  test("cover status, duplicates, retries, lock conflicts, latency, outbox lag, pending references, DLQ", async () => {
    const w = await openWallet(core, "100.00");
    await core.submitWager.execute(wager(w, "BET", "10.00"), { correlationId: "m" });
    const dup = wager(w, "BET", "10.00");
    await core.submitWager.execute(dup, { correlationId: "m" });
    await core.submitWager.execute({ ...dup }, { correlationId: "m" });
    await core.submitWager.execute(wager(w, "BET", "999.00"), { correlationId: "m" });
    await core.submitWager.execute(wager(w, "REFUND", "1.00", { referenceExternalTransactionId: `nope-${newId()}` }), {
      correlationId: "m",
    });

    // Hold the wallet lock from outside so the use case hits lock_timeout (200 ms) on every attempt.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${w.walletId} FOR UPDATE`;
      locked();
      await held;
    });
    await isLocked;
    await expect(core.submitWager.execute(wager(w, "BET", "1.00"), { correlationId: "m" })).rejects.toBeInstanceOf(
      TransientInfrastructureError,
    );
    release();
    await holder;

    await core.sampler.sample();
    const m = core.metrics;
    expect(m.counter("wager_transactions_total", { status: "PROCESSED", kind: "BET" })).toBeGreaterThanOrEqual(2);
    expect(m.counter("wager_transactions_total", { status: "REJECTED", kind: "BET" })).toBeGreaterThanOrEqual(1);
    expect(m.counter("wager_transactions_total", { status: "PENDING_REFERENCE", kind: "REFUND" })).toBe(1);
    expect(m.counter("wager_duplicates_total", { source: "http" })).toBeGreaterThanOrEqual(1);
    expect(m.counter("wager_lock_conflicts_total", { reason: "lock_timeout" })).toBe(4);
    expect(m.counter("wager_retries_total", { reason: "lock_timeout" })).toBe(3);
    expect(m.histogramCount("wallet_lock_wait_ms")).toBeGreaterThan(0);
    expect(m.histogramCount("wager_processing_duration_ms")).toBeGreaterThan(0);

    const text = m.render();
    for (const name of ["outbox_lag_ms", "outbox_pending", "pending_references", "sqs_dlq_depth"]) {
      expect(text).toContain(`# TYPE ${name} gauge`);
    }
    expect(text).toMatch(/pending_references [1-9]/);
    expect(text).toMatch(/outbox_pending [1-9]/); // nothing publishes in this test

    const scraped = await (await fetch(`${base}/metrics`)).text();
    expect(scraped).toContain('http_requests_total{method="POST",route="/wagering/transactions",status="201"}');
    expect(scraped).not.toMatch(/route="\/wallets\/[0-9a-f]{8}-/); // templates, not concrete ids
  });
});

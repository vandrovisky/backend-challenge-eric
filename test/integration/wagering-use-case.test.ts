import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { IdempotencyConflictError, PayloadValidationError, PermanentProcessingError, ResourceConflictError } from "../../src/application/errors";
import type { TransactionRunner } from "../../src/application/ports/persistence";
import { createCore, type Core } from "../../src/composition-root";
import { newId } from "../../src/domain/shared/id";
import { ReferenceRetryPolicy } from "../../src/domain/wagering/reference-retry-policy";
import { silentLogger } from "../../src/infrastructure/observability/json-logger";
import { connect, resetDatabase } from "./support/database";
import { brl, ctx, expectWalletConsistent, ledgerEntries, openWallet, outboxFor, wager } from "./support/fixtures";

let core: Core;
let sql: SQL;

beforeAll(async () => {
  await resetDatabase();
  // Retry policy with zero delay: parked transactions are due immediately (deterministic tests).
  core = await createCore({
    poolMax: 30,
    logger: silentLogger,
    referenceRetryPolicy: new ReferenceRetryPolicy(0, 0, 3, 0),
  });
  sql = connect();
});

afterAll(async () => {
  await core?.close();
  await sql?.close();
});

describe("open wallet", () => {
  test("opening balance creates OPENING tx + CREDIT entry atomically; duplicate is a conflict", async () => {
    const playerId = newId();
    const view = await core.openWallet.execute({ playerId, initialBalance: brl("1000.00") }, ctx());
    expect(view).toMatchObject({ playerId, balance: brl("1000.00"), version: 1 });

    const entries = await ledgerEntries(sql, view.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ direction: "CREDIT", amount: "1000.00", balance_before: "0.00", wallet_version: 1 });
    const [opening] = await sql`SELECT kind, status FROM wager_transactions WHERE id = ${entries[0].transaction_id}`;
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED" });
    expect((await outboxFor(sql, view.id)).map((e: { event_type: string }) => e.event_type)).toEqual(["WalletBalanceChanged"]);

    await expect(core.openWallet.execute({ playerId, initialBalance: brl("1.00") }, ctx())).rejects.toBeInstanceOf(
      ResourceConflictError,
    );
    // Different currency for the same player is a different wallet.
    await core.openWallet.execute({ playerId, initialBalance: { amount: "0.00", currency: "USD" } }, ctx());
    await expectWalletConsistent(sql, view.id, "1000.00");
  });

  test("invalid payloads are rejected before touching the database", async () => {
    await expect(
      core.openWallet.execute({ playerId: "nope", initialBalance: { amount: "1e3", currency: "BRL" } }, ctx()),
    ).rejects.toBeInstanceOf(PayloadValidationError);
  });
});

describe("mandatory scenario (section 8): two concurrent 80.00 bets on 100.00", () => {
  test("exactly one PROCESSED, one REJECTED, final 20.00, one debit", async () => {
    const w = await openWallet(core, "100.00");
    const results = await Promise.all([
      core.submitWager.execute(wager(w, "BET", "80.00"), ctx()),
      core.submitWager.execute(wager(w, "BET", "80.00"), ctx()),
    ]);
    const statuses = results.map((r) => String(r.status)).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = results.find((r) => r.status === "REJECTED")!;
    expect(String(rejected.failureCode)).toBe("INSUFFICIENT_FUNDS");
    expect(rejected.balance).toEqual(brl("20.00"));

    const debits = (await ledgerEntries(sql, w.walletId)).filter((e: { direction: string }) => e.direction === "DEBIT");
    expect(debits).toHaveLength(1);
    await expectWalletConsistent(sql, w.walletId, "20.00");
  });
});

describe("idempotency", () => {
  test("the same bet sent 50 times in parallel debits once; 49 replays return the original result", async () => {
    const w = await openWallet(core, "100.00");
    const cmd = wager(w, "BET", "25.00");
    const results = await Promise.all(Array.from({ length: 50 }, () => core.submitWager.execute({ ...cmd }, ctx())));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === "PROCESSED" && r.balance?.amount === "75.00")).toBe(true);
    expect(await ledgerEntries(sql, w.walletId)).toHaveLength(2); // opening + one debit
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ${cmd.idempotencyKey as string}`;
    expect(n).toBe(1);
    await expectWalletConsistent(sql, w.walletId, "75.00");
  });

  test("replay returns the balance observed at the time, not the current one", async () => {
    const w = await openWallet(core, "100.00");
    const first = wager(w, "BET", "10.00");
    await core.submitWager.execute(first, ctx());
    await core.submitWager.execute(wager(w, "BET", "50.00"), ctx());
    const replay = await core.submitWager.execute({ ...first }, ctx());
    expect(replay).toMatchObject({ idempotentReplay: true, status: "PROCESSED", balance: brl("90.00") });
    await expectWalletConsistent(sql, w.walletId, "40.00");
  });

  test("same key with a different payload is a conflict, never a replay", async () => {
    const w = await openWallet(core, "100.00");
    const cmd = wager(w, "BET", "10.00");
    await core.submitWager.execute(cmd, ctx());
    await expect(core.submitWager.execute({ ...cmd, money: brl("10.01") }, ctx())).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    // same external id under a different key
    await expect(
      core.submitWager.execute({ ...cmd, idempotencyKey: "another-key" }, ctx()),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expectWalletConsistent(sql, w.walletId, "90.00");
  });

  test("rejections are idempotent too (REJECTED is persisted and replayed)", async () => {
    const w = await openWallet(core, "10.00");
    const cmd = wager(w, "BET", "50.00");
    const a = await core.submitWager.execute(cmd, ctx());
    const b = await core.submitWager.execute({ ...cmd }, ctx());
    expect(a).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: false });
    expect(b).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: true, transactionId: a.transactionId });
  });

  test("unknown wallet: 20 parallel duplicates produce a single REJECTED row", async () => {
    const w = { walletId: newId(), playerId: newId() };
    const cmd = wager(w, "BET", "1.00");
    const results = await Promise.all(Array.from({ length: 20 }, () => core.submitWager.execute({ ...cmd }, ctx())));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.failureCode === "WALLET_NOT_FOUND")).toBe(true);
  });

  test("queue inbox: the same messageId twice in parallel has one effect; reused id with another payload conflicts", async () => {
    const w = await openWallet(core, "100.00");
    const cmd = wager(w, "BET", "30.00");
    const inbox = { consumerName: "wager-consumer", messageId: `msg-${newId()}` };
    const [a, b] = await Promise.all([
      core.submitWager.execute({ ...cmd }, { ...ctx(), inbox }),
      core.submitWager.execute({ ...cmd }, { ...ctx(), inbox }),
    ]);
    expect(a.transactionId).toBe(b.transactionId);
    expect([a.idempotentReplay, b.idempotentReplay].sort()).toEqual([false, true]);
    const [row] = await sql`SELECT processed_at IS NOT NULL AS done, transaction_id FROM inbox_messages WHERE message_id = ${inbox.messageId}`;
    expect(row).toEqual({ done: true, transaction_id: a.transactionId });

    await expect(
      core.submitWager.execute(wager(w, "BET", "1.00"), { ...ctx(), inbox }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expectWalletConsistent(sql, w.walletId, "70.00");
  });
});

describe("concurrency across wallets", () => {
  test("20 wallets × 10 concurrent bets each, all in parallel", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(core, "100.00")));
    const results = await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => core.submitWager.execute(wager(w, "BET", "15.00"), ctx()))),
    );
    // 100 / 15 → 6 bets fit per wallet, 4 rejected
    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(20 * 6);
    expect(results.filter((r) => r.status === "REJECTED")).toHaveLength(20 * 4);
    for (const w of wallets) await expectWalletConsistent(sql, w.walletId, "10.00");
  });

  test("mixed concurrent BET/WIN/LOSS on a hot wallet never goes negative and always reconciles", async () => {
    const w = await openWallet(core, "50.00");
    const ops = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0 ? wager(w, "WIN", "7.00") : i % 3 === 1 ? wager(w, "BET", "11.00") : wager(w, "LOSS", "0.00"),
    );
    await Promise.all(ops.map((op) => core.submitWager.execute(op, ctx())));
    const [{ balance }] = await sql`SELECT balance FROM wallets WHERE id = ${w.walletId}`;
    expect(Number.parseFloat(balance) >= 0).toBe(true);
    await expectWalletConsistent(sql, w.walletId);
  });
});

describe("reversals", () => {
  test("REFUND of a BET, once; a second reversal (any kind) is rejected", async () => {
    const w = await openWallet(core, "100.00");
    const bet = wager(w, "BET", "40.00");
    await core.submitWager.execute(bet, ctx());
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    const refund = await core.submitWager.execute(wager(w, "REFUND", "40.00", ref), ctx());
    expect(refund).toMatchObject({ status: "PROCESSED", balance: brl("100.00") });
    const again = await core.submitWager.execute(wager(w, "ROLLBACK", "40.00", ref), ctx());
    expect(again).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED" });
    await expectWalletConsistent(sql, w.walletId, "100.00");
  });

  test("two different refunds of the same BET racing: exactly one wins", async () => {
    const w = await openWallet(core, "100.00");
    const bet = wager(w, "BET", "40.00");
    await core.submitWager.execute(bet, ctx());
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => core.submitWager.execute(wager(w, "REFUND", "40.00", ref), ctx())),
    );
    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === "REFERENCE_ALREADY_REVERSED")).toHaveLength(9);
    await expectWalletConsistent(sql, w.walletId, "100.00");
  });

  test("ROLLBACK of a WIN that would go negative is rejected with its own code", async () => {
    const w = await openWallet(core, "0.00");
    const win = wager(w, "WIN", "30.00");
    await core.submitWager.execute(win, ctx());
    await core.submitWager.execute(wager(w, "BET", "25.00"), ctx());
    const rb = await core.submitWager.execute(
      wager(w, "ROLLBACK", "30.00", { referenceExternalTransactionId: win.externalTransactionId }),
      ctx(),
    );
    expect(rb).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS", balance: brl("5.00") });
    await expectWalletConsistent(sql, w.walletId, "5.00");
  });
});

describe("out-of-order references", () => {
  test("REFUND before its BET: parked, then applied by the worker once the BET arrives", async () => {
    const w = await openWallet(core, "100.00");
    const betExt = `bet-${newId()}`;
    const refund = await core.submitWager.execute(
      wager(w, "REFUND", "20.00", { referenceExternalTransactionId: betExt }),
      ctx(),
    );
    expect(String(refund.status)).toBe("PENDING_REFERENCE");
    expect((await outboxFor(sql, refund.transactionId)).map((e: { event_type: string }) => e.event_type)).toEqual([
      "WagerTransactionPendingReference",
    ]);

    await core.submitWager.execute(wager(w, "BET", "20.00", { externalTransactionId: betExt }), ctx());
    await expectWalletConsistent(sql, w.walletId, "80.00");

    const summary = await core.reprocessPendingReferences.runOnce();
    expect(summary.processed).toBeGreaterThanOrEqual(1);
    const [row] = await sql`SELECT status FROM wager_transactions WHERE id = ${refund.transactionId}`;
    expect(row.status).toBe("PROCESSED");
    await expectWalletConsistent(sql, w.walletId, "100.00");

    // Replaying the original REFUND now reports the final outcome.
    const replay = await core.submitWager.execute(
      wager(w, "REFUND", "20.00", {
        referenceExternalTransactionId: betExt,
        externalTransactionId: (await sql`SELECT external_transaction_id FROM wager_transactions WHERE id = ${refund.transactionId}`)[0]
          .external_transaction_id,
      }),
      ctx(),
    );
    expect(replay).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
  });

  test("reference that never arrives: rejected REFERENCE_NOT_FOUND after the retry budget", async () => {
    const w = await openWallet(core, "100.00");
    const rb = await core.submitWager.execute(
      wager(w, "ROLLBACK", "5.00", { referenceExternalTransactionId: `ghost-${newId()}` }),
      ctx(),
    );
    for (let i = 0; i < 5; i++) await core.reprocessPendingReferences.runOnce();
    const [row] = await sql`SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE id = ${rb.transactionId}`;
    expect(row).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
    const events = (await outboxFor(sql, rb.transactionId)).map((e: { event_type: string }) => e.event_type);
    expect(events).toContain("WagerTransactionRejected");
    await expectWalletConsistent(sql, w.walletId, "100.00");
  });

  test("concurrent workers reprocessing the same backlog apply each transaction once", async () => {
    const w = await openWallet(core, "100.00");
    const bets = Array.from({ length: 10 }, () => `bet-${newId()}`);
    for (const ext of bets) {
      await core.submitWager.execute(wager(w, "REFUND", "1.00", { referenceExternalTransactionId: ext }), ctx());
    }
    for (const ext of bets) await core.submitWager.execute(wager(w, "BET", "1.00", { externalTransactionId: ext }), ctx());
    await Promise.all(Array.from({ length: 4 }, () => core.reprocessPendingReferences.runOnce()));
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${w.walletId} AND kind = 'REFUND' AND status = 'PROCESSED'`;
    expect(n).toBe(10);
    await expectWalletConsistent(sql, w.walletId, "100.00");
  });
});

describe("atomicity", () => {
  test("a failure after the ledger write rolls back everything; the attempt is recorded as FAILED", async () => {
    let failOutbox = true;
    const faulty = await createCore({
      poolMax: 5,
      logger: silentLogger,
      wrapRunner: (inner): TransactionRunner => ({
        read: (work) => inner.read(work),
        run: (work) =>
          inner.run((repos) =>
            work({
              ...repos,
              outbox: {
                ...repos.outbox,
                enqueue: async (m) => {
                  if (failOutbox) throw new Error("simulated crash while writing the outbox");
                  return repos.outbox.enqueue(m);
                },
              },
            }),
          ),
      }),
    });
    try {
      const w = await openWallet(core, "100.00");
      const cmd = wager(w, "BET", "60.00");
      await expect(faulty.submitWager.execute(cmd, ctx())).rejects.toBeInstanceOf(PermanentProcessingError);

      // No partial effect: balance, ledger and outbox untouched.
      await expectWalletConsistent(sql, w.walletId, "100.00");
      expect(await ledgerEntries(sql, w.walletId)).toHaveLength(1);
      const [tx] = await sql`SELECT id, status, failure_code FROM wager_transactions WHERE idempotency_key = ${cmd.idempotencyKey as string}`;
      expect(tx).toMatchObject({ status: "FAILED", failure_code: "PERMANENT_PROCESSING_ERROR" });
      expect(await outboxFor(sql, tx.id)).toHaveLength(0);

      // FAILED is terminal: a retry replays it instead of applying it.
      failOutbox = false;
      const replay = await faulty.submitWager.execute({ ...cmd }, ctx());
      expect(replay).toMatchObject({ status: "FAILED", idempotentReplay: true });
      await expectWalletConsistent(sql, w.walletId, "100.00");
    } finally {
      await faulty.close();
    }
  });

  test("processed BET writes tx, balance, ledger and both events in one commit", async () => {
    const w = await openWallet(core, "100.00");
    const r = await core.submitWager.execute(wager(w, "BET", "25.00"), ctx("corr-atomic"));
    const events = await sql`SELECT event_type, payload FROM outbox_messages WHERE payload->>'correlationId' = 'corr-atomic' ORDER BY event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    const changed = events.find((e: { event_type: string }) => e.event_type === "WalletBalanceChanged").payload;
    expect(changed.data).toMatchObject({ transactionId: r.transactionId, balanceAfter: brl("75.00"), walletVersion: 2 });
    await expectWalletConsistent(sql, w.walletId, "75.00");
  });

  test("LOSS emits WagerTransactionProcessed but not WalletBalanceChanged", async () => {
    const w = await openWallet(core, "100.00");
    const r = await core.submitWager.execute(wager(w, "LOSS", "10.00"), ctx());
    expect((await outboxFor(sql, r.transactionId)).map((e: { event_type: string }) => e.event_type)).toEqual([
      "WagerTransactionProcessed",
    ]);
    const [{ version }] = await sql`SELECT version FROM wallets WHERE id = ${w.walletId}`;
    expect(version).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { newId } from "../../src/domain/shared/id";
import { connect, resetDatabase } from "./support/database";

/**
 * Proves that the invariants of section 6 are enforced by the database itself:
 * these tests write raw SQL, bypassing every line of application code.
 */
let sql: SQL;

beforeAll(async () => {
  await resetDatabase();
  sql = connect();
});

afterAll(async () => {
  await sql?.close();
});

const now = new Date("2026-07-29T15:00:00Z");

async function insertTx(
  db: SQL,
  o: { id?: string; walletId: string; playerId: string; kind?: string; amount?: string; status?: string; extra?: Record<string, unknown> },
) {
  const id = o.id ?? newId();
  const kind = o.kind ?? "BET";
  const isOpening = kind === "OPENING";
  const status = o.status ?? "PENDING";
  const row = {
    id,
    provider_id: isOpening ? "internal" : "provider-a",
    external_transaction_id: `ext-${id}`,
    idempotency_key: `key-${id}`,
    payload_hash: "sha256:x",
    wallet_id: o.walletId,
    player_id: o.playerId,
    round_id: "round-1",
    game_id: "game",
    kind,
    amount: o.amount ?? "10.00",
    currency: "BRL",
    status,
    created_at: now,
    updated_at: now,
    ...(status === "PROCESSED" ? { processed_at: now, resulting_balance: "0.00" } : {}),
    ...o.extra,
  };
  await db`INSERT INTO wager_transactions ${db(row)}`;
  return id;
}

/** Valid wallet + OPENING tx + opening ledger entry, committed. */
async function openWallet(balance = "100.00") {
  const walletId = newId();
  const playerId = newId();
  await sql.begin(async (tx) => {
    const openingId = await insertTx(tx, {
      walletId,
      playerId,
      kind: "OPENING",
      amount: balance,
      status: "PROCESSED",
      extra: { resulting_balance: balance },
    });
    await tx`INSERT INTO wallets ${tx({ id: walletId, player_id: playerId, currency: "BRL", balance, version: 1, created_at: now, updated_at: now })}`;
    await tx`INSERT INTO wallet_ledger_entries ${tx({
      id: newId(),
      wallet_id: walletId,
      transaction_id: openingId,
      direction: "CREDIT",
      amount: balance,
      currency: "BRL",
      balance_before: "0.00",
      balance_after: balance,
      wallet_version: 1,
      created_at: now,
    })}`;
  });
  return { walletId, playerId };
}

function ledgerRow(o: {
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  before: string;
  after: string;
  version: number;
  currency?: string;
}) {
  return {
    id: newId(),
    wallet_id: o.walletId,
    transaction_id: o.transactionId,
    direction: o.direction,
    amount: o.amount,
    currency: o.currency ?? "BRL",
    balance_before: o.before,
    balance_after: o.after,
    wallet_version: o.version,
    created_at: now,
  };
}

/** A correct BET: tx + wallet update + ledger entry in one transaction. */
async function bet(walletId: string, playerId: string, amount: string, before: string, after: string, version: number) {
  return sql.begin(async (tx) => {
    const txId = await insertTx(tx, { walletId, playerId, amount });
    await tx`UPDATE wallets SET balance = ${after}, version = ${version}, updated_at = now() WHERE id = ${walletId}`;
    await tx`INSERT INTO wallet_ledger_entries ${tx(ledgerRow({ walletId, transactionId: txId, direction: "DEBIT", amount, before, after, version }))}`;
    return txId;
  });
}

async function expectSqlError(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toMatch(pattern);
}

describe("schema: happy path", () => {
  test("opening + bet commit and the ledger chain reconstructs the balance", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await bet(walletId, playerId, "25.00", "100.00", "75.00", 2);
    const [w] = await sql`SELECT balance, version FROM wallets WHERE id = ${walletId}`;
    const [l] = await sql`
      SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total
      FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
    expect(w.balance).toBe("75.00");
    expect(w.version).toBe(2);
    expect(l.total).toBe("75.00");
  });
});

describe("schema: wallets", () => {
  test("one wallet per player + currency", async () => {
    const playerId = newId();
    const id = newId();
    await sql`INSERT INTO wallets ${sql({ id, player_id: playerId, currency: "USD", balance: "0.00", version: 1, created_at: now, updated_at: now })}`;
    await expectSqlError(
      sql`INSERT INTO wallets ${sql({ id: newId(), player_id: playerId, currency: "USD", balance: "0.00", version: 1, created_at: now, updated_at: now })}`,
      /uq_wallets_player_currency/,
    );
  });

  test("balance can never be negative", async () => {
    const { walletId } = await openWallet("10.00");
    await expectSqlError(sql`UPDATE wallets SET balance = -0.01, version = 2 WHERE id = ${walletId}`, /wallets_balance_check/);
  });

  test("balance change without a matching ledger entry is rejected at commit", async () => {
    const { walletId } = await openWallet("10.00");
    await expectSqlError(
      sql.begin(async (tx) => {
        await tx`UPDATE wallets SET balance = 999.00, version = 2 WHERE id = ${walletId}`;
      }),
      /has no matching ledger entry/,
    );
    const [w] = await sql`SELECT balance FROM wallets WHERE id = ${walletId}`;
    expect(w.balance).toBe("10.00");
  });

  test("version must increment by exactly 1 when the balance changes, and only then", async () => {
    const { walletId } = await openWallet("10.00");
    await expectSqlError(sql`UPDATE wallets SET balance = 5.00, version = 3 WHERE id = ${walletId}`, /increment by 1/);
    await expectSqlError(sql`UPDATE wallets SET version = 2 WHERE id = ${walletId}`, /must not change/);
  });

  test("positive opening without ledger entry is rejected; wallets cannot be deleted", async () => {
    await expectSqlError(
      sql`INSERT INTO wallets ${sql({ id: newId(), player_id: newId(), currency: "BRL", balance: "50.00", version: 1, created_at: now, updated_at: now })}`,
      /has no matching ledger entry/,
    );
    const { walletId } = await openWallet("1.00");
    await expectSqlError(sql`DELETE FROM wallets WHERE id = ${walletId}`, /cannot be deleted/);
  });
});

describe("schema: ledger", () => {
  test("is append-only: UPDATE, DELETE and TRUNCATE are blocked", async () => {
    const { walletId } = await openWallet("10.00");
    await expectSqlError(sql`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${walletId}`, /append-only/);
    await expectSqlError(sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`, /append-only/);
    await expectSqlError(sql`TRUNCATE wallet_ledger_entries CASCADE`, /append-only/);
  });

  test("entry arithmetic must balance", async () => {
    const { walletId, playerId } = await openWallet("10.00");
    const txId = await insertTx(sql, { walletId, playerId });
    await expectSqlError(
      sql`INSERT INTO wallet_ledger_entries ${sql(ledgerRow({ walletId, transactionId: txId, direction: "DEBIT", amount: "5.00", before: "10.00", after: "6.00", version: 2 }))}`,
      /ck_ledger_balanced/,
    );
  });

  test("entry currency must match the wallet currency", async () => {
    const { walletId, playerId } = await openWallet("10.00");
    const txId = await insertTx(sql, { walletId, playerId });
    await expectSqlError(
      sql`INSERT INTO wallet_ledger_entries ${sql(ledgerRow({ walletId, transactionId: txId, direction: "DEBIT", amount: "5.00", before: "10.00", after: "5.00", version: 2, currency: "USD" }))}`,
      /fk_ledger_wallet_currency/,
    );
  });

  test("at most one entry per transaction per wallet", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    const txId = await bet(walletId, playerId, "10.00", "100.00", "90.00", 2);
    await expectSqlError(
      sql.begin(async (tx) => {
        await tx`UPDATE wallets SET balance = 80.00, version = 3 WHERE id = ${walletId}`;
        await tx`INSERT INTO wallet_ledger_entries ${tx(ledgerRow({ walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "90.00", after: "80.00", version: 3 }))}`;
      }),
      /uq_ledger_transaction_wallet/,
    );
  });

  test("two writers cannot both produce the same wallet version (lost-update guard)", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    const otherTx = await insertTx(sql, { walletId, playerId });
    await bet(walletId, playerId, "10.00", "100.00", "90.00", 2);
    // A writer that read the stale balance (100.00, v1) tries to write its own v2.
    await expectSqlError(
      sql`INSERT INTO wallet_ledger_entries ${sql(ledgerRow({ walletId, transactionId: otherTx, direction: "DEBIT", amount: "80.00", before: "100.00", after: "20.00", version: 2 }))}`,
      /uq_ledger_wallet_version/,
    );
  });

  test("chain must be continuous: balance_before == previous balance_after", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    const txId = await insertTx(sql, { walletId, playerId });
    await expectSqlError(
      sql`INSERT INTO wallet_ledger_entries ${sql(ledgerRow({ walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "50.00", after: "40.00", version: 2 }))}`,
      /ledger chain broken/,
    );
  });

  test("entry must belong to a transaction of the same wallet", async () => {
    const a = await openWallet("100.00");
    const b = await openWallet("100.00");
    const txOfB = await insertTx(sql, { walletId: b.walletId, playerId: b.playerId });
    await expectSqlError(
      sql`INSERT INTO wallet_ledger_entries ${sql(ledgerRow({ walletId: a.walletId, transactionId: txOfB, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", version: 2 }))}`,
      /fk_ledger_transaction_wallet/,
    );
  });
});

describe("schema: wager transactions", () => {
  test("idempotency key and (provider, external id) are unique", async () => {
    const { walletId, playerId } = await openWallet("1.00");
    const id = await insertTx(sql, { walletId, playerId });
    await expectSqlError(
      insertTx(sql, { walletId, playerId, extra: { idempotency_key: `key-${id}` } }),
      /uq_wager_tx_idempotency_key/,
    );
    await expectSqlError(
      insertTx(sql, { walletId, playerId, extra: { external_transaction_id: `ext-${id}` } }),
      /uq_wager_tx_provider_external/,
    );
  });

  test("REFUND/ROLLBACK require a reference; BET cannot carry one", async () => {
    const { walletId, playerId } = await openWallet("1.00");
    await expectSqlError(insertTx(sql, { walletId, playerId, kind: "REFUND" }), /ck_wager_tx_reference_required/);
    await expectSqlError(
      insertTx(sql, { walletId, playerId, extra: { reference_external_transaction_id: "x" } }),
      /ck_wager_tx_reference_forbidden/,
    );
  });

  test("OPENING only from the internal provider; amounts never negative", async () => {
    const { walletId, playerId } = await openWallet("1.00");
    await expectSqlError(
      insertTx(sql, { walletId, playerId, kind: "OPENING", extra: { provider_id: "provider-a" } }),
      /ck_wager_tx_opening_internal/,
    );
    await expectSqlError(insertTx(sql, { walletId, playerId, kind: "LOSS", amount: "-1.00" }), /wager_transactions_amount_check/);
    await expectSqlError(insertTx(sql, { walletId, playerId, amount: "0.00" }), /ck_wager_tx_positive_amount/);
  });

  test("terminal transactions are frozen; business fields immutable; no deletes", async () => {
    const { walletId, playerId } = await openWallet("1.00");
    const pending = await insertTx(sql, { walletId, playerId });
    await expectSqlError(sql`UPDATE wager_transactions SET amount = 99 WHERE id = ${pending}`, /immutable/);
    await sql`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = now() WHERE id = ${pending}`;
    await expectSqlError(
      sql`UPDATE wager_transactions SET status = 'PENDING', failure_code = NULL, processed_at = NULL WHERE id = ${pending}`,
      /is terminal/,
    );
    await expectSqlError(sql`DELETE FROM wager_transactions WHERE id = ${pending}`, /cannot be deleted/);
  });

  test("status and its fields must agree", async () => {
    const { walletId, playerId } = await openWallet("1.00");
    await expectSqlError(insertTx(sql, { walletId, playerId, status: "REJECTED" }), /ck_wager_tx_status_fields/);
  });

  test("a transaction can be reversed at most once (REFUND or ROLLBACK)", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    const betId = await bet(walletId, playerId, "10.00", "100.00", "90.00", 2);
    const reversal = (kind: string, ext: string) =>
      insertTx(sql, {
        walletId,
        playerId,
        kind,
        status: "PROCESSED",
        extra: { reference_external_transaction_id: ext, reference_transaction_id: betId },
      });
    await reversal("REFUND", `ext-${betId}`);
    await expectSqlError(reversal("ROLLBACK", `ext-${betId}`), /uq_wager_tx_single_reversal/);
    await expectSqlError(reversal("REFUND", `ext-${betId}`), /uq_wager_tx_single_reversal/);
  });
});

describe("schema: inbox / outbox", () => {
  test("inbox dedupes by (consumer, messageId)", async () => {
    const row = { consumer_name: "wager-consumer", message_id: "msg-1", payload_hash: "h", received_at: now };
    await sql`INSERT INTO inbox_messages ${sql(row)}`;
    await expectSqlError(sql`INSERT INTO inbox_messages ${sql(row)}`, /inbox_messages_pkey/);
  });

  test("outbox payload is immutable and publication is final", async () => {
    const id = newId();
    await sql`INSERT INTO outbox_messages ${sql({ id, aggregate_id: newId(), event_type: "X", payload: { a: 1 }, occurred_at: now, next_attempt_at: now })}`;
    await expectSqlError(sql`UPDATE outbox_messages SET payload = '{"a":2}' WHERE id = ${id}`, /immutable/);
    await sql`UPDATE outbox_messages SET published_at = now() WHERE id = ${id}`;
    await expectSqlError(sql`UPDATE outbox_messages SET published_at = NULL WHERE id = ${id}`, /already published/);
  });
});

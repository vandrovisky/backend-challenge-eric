import { beforeEach, describe, expect, test } from "bun:test";
import { InvalidTransactionStateError, ValidationError } from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/shared/money";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { ReferenceRetryPolicy } from "../../src/domain/wagering/reference-retry-policy";
import { WagerProcessor, type ReferenceLookup } from "../../src/domain/wagering/wager-processor";
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
  type CreateWagerTransactionProps,
} from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-07-29T15:00:00Z");
const NONE: ReferenceLookup = { alreadyReversed: false };

let seq = 0;
function tx(kind: K, amount: string, extra: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  seq += 1;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: `hash-${seq}`,
    walletId: "w1",
    playerId: "p1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    createdAt: now,
    ...extra,
  });
}

let wallet: Wallet;
const processor = new WagerProcessor(new ReferenceRetryPolicy(1000, 60_000, 3, 0));

function processed(t: WagerTransaction, lookup: ReferenceLookup = NONE) {
  return processor.process(t, wallet, lookup, now);
}

beforeEach(() => {
  wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), openingTransactionId: "o", at: now })
    .wallet;
});

describe("WagerTransaction shape", () => {
  test("REFUND and ROLLBACK require a reference", () => {
    expect(() => tx(K.Refund, "10.00")).toThrow(ValidationError);
    expect(() => tx(K.Rollback, "10.00")).toThrow(ValidationError);
  });

  test("BET / LOSS cannot carry a reference; WIN may", () => {
    expect(() => tx(K.Bet, "10.00", { referenceExternalTransactionId: "x" })).toThrow(ValidationError);
    expect(() => tx(K.Loss, "0.00", { referenceExternalTransactionId: "x" })).toThrow(ValidationError);
    expect(tx(K.Win, "10.00", { referenceExternalTransactionId: "x" }).hasReference()).toBe(true);
  });

  test("OPENING cannot be submitted", () => {
    expect(() => tx(K.Opening, "10.00")).toThrow(ValidationError);
  });

  test("balance-moving kinds need a positive amount; LOSS may be zero", () => {
    expect(() => tx(K.Bet, "0.00")).toThrow(ValidationError);
    expect(tx(K.Loss, "0.00").affectsBalance()).toBe(false);
  });

  test("terminal states cannot transition", () => {
    const t = tx(K.Bet, "10.00");
    t.markProcessed(undefined, brl("90.00"), now);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.reject(FailureCode.InsufficientFunds, undefined, now)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(now)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.PermanentProcessingError, now)).toThrow(InvalidTransactionStateError);
    expect(() => t.markProcessed(undefined, brl("1.00"), now)).toThrow(InvalidTransactionStateError);
  });

  test("matchesPayload compares the stored hash", () => {
    const t = tx(K.Bet, "10.00", { payloadHash: "sha256:abc" });
    expect(t.matchesPayload("sha256:abc")).toBe(true);
    expect(t.matchesPayload("sha256:abd")).toBe(false);
  });
});

describe("BET", () => {
  test("debits and produces a DEBIT entry", () => {
    const t = tx(K.Bet, "25.00");
    const out = processed(t);
    expect(out.type).toBe("processed");
    if (out.type !== "processed") throw new Error();
    expect(out.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("75.00");
    expect(t.status).toBe(S.Processed);
    expect(t.resultingBalance?.amount).toBe("75.00");
  });

  test("rejects on insufficient funds without moving the balance", () => {
    const t = tx(K.Bet, "100.01");
    expect(processed(t)).toEqual({ type: "rejected", code: FailureCode.InsufficientFunds });
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(t.status).toBe(S.Rejected);
  });

  test("two 80.00 bets on 100.00 — exactly one wins (sequential domain view)", () => {
    const a = tx(K.Bet, "80.00");
    const b = tx(K.Bet, "80.00");
    expect(processed(a).type).toBe("processed");
    expect(processed(b)).toEqual({ type: "rejected", code: FailureCode.InsufficientFunds });
    expect(wallet.balance.amount).toBe("20.00");
  });

  test("currency mismatch is rejected", () => {
    const t = tx(K.Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
    expect(processed(t)).toEqual({ type: "rejected", code: FailureCode.CurrencyMismatch });
  });

  test("wallet missing or owned by another player is rejected", () => {
    expect(processor.process(tx(K.Bet, "1.00"), undefined, NONE, now)).toEqual({
      type: "rejected",
      code: FailureCode.WalletNotFound,
    });
    expect(processed(tx(K.Bet, "1.00", { playerId: "someone-else" }))).toEqual({
      type: "rejected",
      code: FailureCode.WalletPlayerMismatch,
    });
  });
});

describe("WIN / LOSS", () => {
  test("WIN credits", () => {
    const out = processed(tx(K.Win, "50.00"));
    expect(out.type).toBe("processed");
    expect(wallet.balance.amount).toBe("150.00");
  });

  test("WIN referencing a BET of the same round credits and links the reference", () => {
    const bet = tx(K.Bet, "10.00");
    processed(bet);
    const win = tx(K.Win, "30.00", { referenceExternalTransactionId: bet.externalTransactionId });
    processed(win, { reference: bet, alreadyReversed: false });
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe("120.00");
  });

  test("LOSS is processed without touching balance or ledger", () => {
    const t = tx(K.Loss, "10.00");
    const out = processed(t);
    expect(out).toEqual({ type: "processed", reference: undefined });
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(t.status).toBe(S.Processed);
  });
});

describe("REFUND", () => {
  test("credits back a PROCESSED BET", () => {
    const bet = tx(K.Bet, "40.00");
    processed(bet);
    const refund = tx(K.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const out = processed(refund, { reference: bet, alreadyReversed: false });
    expect(out.type).toBe("processed");
    if (out.type !== "processed") throw new Error();
    expect(out.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("only once", () => {
    const bet = tx(K.Bet, "40.00");
    processed(bet);
    const refund = tx(K.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(processed(refund, { reference: bet, alreadyReversed: true })).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("only a BET", () => {
    const win = tx(K.Win, "40.00");
    processed(win);
    const refund = tx(K.Refund, "40.00", { referenceExternalTransactionId: win.externalTransactionId });
    expect(processed(refund, { reference: win, alreadyReversed: false })).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("amount must equal the reference", () => {
    const bet = tx(K.Bet, "40.00");
    processed(bet);
    const refund = tx(K.Refund, "39.99", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(processed(refund, { reference: bet, alreadyReversed: false })).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceAmountMismatch,
    });
  });

  test("reference must be in the same round / player / wallet", () => {
    const bet = tx(K.Bet, "40.00");
    processed(bet);
    const refund = tx(K.Refund, "40.00", { referenceExternalTransactionId: bet.externalTransactionId, roundId: "r2" });
    expect(processed(refund, { reference: bet, alreadyReversed: false })).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceMismatch,
    });
  });

  test("reference that ended REJECTED cannot be refunded", () => {
    const bet = tx(K.Bet, "500.00");
    processed(bet); // rejected: insufficient funds
    const refund = tx(K.Refund, "500.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(processed(refund, { reference: bet, alreadyReversed: false })).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits", () => {
    const bet = tx(K.Bet, "40.00");
    processed(bet);
    const rb = tx(K.Rollback, "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    processed(rb, { reference: bet, alreadyReversed: false });
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("of a WIN debits", () => {
    const win = tx(K.Win, "40.00");
    processed(win);
    const rb = tx(K.Rollback, "40.00", { referenceExternalTransactionId: win.externalTransactionId });
    const out = processed(rb, { reference: win, alreadyReversed: false });
    if (out.type !== "processed") throw new Error(JSON.stringify(out));
    expect(out.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("of a WIN that would go negative is rejected with a dedicated code", () => {
    const win = tx(K.Win, "40.00");
    processed(win);
    processed(tx(K.Bet, "130.00")); // balance 10.00
    const rb = tx(K.Rollback, "40.00", { referenceExternalTransactionId: win.externalTransactionId });
    expect(processed(rb, { reference: win, alreadyReversed: false })).toEqual({
      type: "rejected",
      code: FailureCode.ReversalInsufficientFunds,
    });
    expect(wallet.balance.amount).toBe("10.00");
  });

  test("cannot reference LOSS", () => {
    const loss = tx(K.Loss, "10.00");
    processed(loss);
    const rb = tx(K.Rollback, "10.00", { referenceExternalTransactionId: loss.externalTransactionId });
    expect(processed(rb, { reference: loss, alreadyReversed: false })).toEqual({
      type: "rejected",
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });
});

describe("out-of-order references", () => {
  test("missing reference parks as PENDING_REFERENCE with backoff, then rejects when exhausted", () => {
    const rb = tx(K.Rollback, "10.00", { referenceExternalTransactionId: "not-yet" });
    expect(processed(rb)).toEqual({ type: "pending_reference" });
    expect(rb.status).toBe(S.PendingReference);
    expect(rb.referenceAttempts).toBe(0);
    expect(rb.nextReferenceCheckAt?.getTime()).toBe(now.getTime() + 1000);

    expect(processed(rb).type).toBe("pending_reference");
    expect(rb.referenceAttempts).toBe(1);
    expect(rb.nextReferenceCheckAt?.getTime()).toBe(now.getTime() + 2000);

    expect(processed(rb).type).toBe("pending_reference");
    expect(rb.referenceAttempts).toBe(2);

    expect(processed(rb)).toEqual({ type: "rejected", code: FailureCode.ReferenceNotFound });
    expect(rb.status).toBe(S.Rejected);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("parked reversal is applied once the reference arrives", () => {
    const rb = tx(K.Refund, "10.00", { referenceExternalTransactionId: "bet-late" });
    processed(rb);
    const bet = tx(K.Bet, "10.00", { externalTransactionId: "bet-late" });
    processed(bet);
    expect(wallet.balance.amount).toBe("90.00");
    expect(processed(rb, { reference: bet, alreadyReversed: false }).type).toBe("processed");
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("reference that is itself still pending keeps the dependent waiting", () => {
    const inner = tx(K.Refund, "10.00", { referenceExternalTransactionId: "zzz" });
    processed(inner); // PENDING_REFERENCE
    const rb = tx(K.Rollback, "10.00", { referenceExternalTransactionId: inner.externalTransactionId });
    expect(processed(rb, { reference: inner, alreadyReversed: false })).toEqual({ type: "pending_reference" });
  });
});

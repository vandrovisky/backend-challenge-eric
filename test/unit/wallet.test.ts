import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvariantViolationError,
} from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/shared/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-07-29T15:00:00Z");

function openWallet(amount = "100.00") {
  return Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(amount), openingTransactionId: "tx-open", at });
}

describe("Wallet", () => {
  test("opens at version 1 with an opening CREDIT entry", () => {
    const { wallet, openingEntry } = openWallet("1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("1000.00");
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("1000.00");
  });

  test("opening at zero creates no ledger entry and is still version 1", () => {
    const { wallet, openingEntry } = Wallet.open({ id: "w", playerId: "p", initialBalance: Money.zero("BRL"), at });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("positive opening requires an opening transaction", () => {
    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1.00"), at })).toThrow(
      InvariantViolationError,
    );
  });

  test("debit decreases balance, bumps version, returns balanced entry", () => {
    const { wallet } = openWallet();
    const entry = wallet.debit(brl("25.00"), "tx1", at);
    expect(wallet.balance.amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("75.00");
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletVersion).toBe(2);
  });

  test("credit increases balance and bumps version", () => {
    const { wallet } = openWallet();
    wallet.credit(brl("0.01"), "tx1", at);
    expect(wallet.balance.amount).toBe("100.01");
    expect(wallet.version).toBe(2);
  });

  test("debit of the exact balance is allowed; beyond it is rejected without side effects", () => {
    const { wallet } = openWallet();
    expect(() => wallet.debit(brl("100.01"), "tx1", at)).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    wallet.debit(brl("100.00"), "tx2", at);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("rejects zero and foreign-currency movements", () => {
    const { wallet } = openWallet();
    expect(() => wallet.credit(Money.zero("BRL"), "tx", at)).toThrow(InvariantViolationError);
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit(usd, "tx", at)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, "tx", at)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("balance always equals the ledger replay", () => {
    const { wallet, openingEntry } = openWallet();
    const entries = [openingEntry!];
    entries.push(wallet.debit(brl("30.00"), "a", at));
    entries.push(wallet.credit(brl("12.34"), "b", at));
    entries.push(wallet.debit(brl("82.34"), "c", at));
    const replay = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));
    expect(replay.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(4);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    walletId: "w",
    transactionId: "t",
    direction: LedgerDirection.Credit,
    money: brl("10.00"),
    balanceBefore: brl("5.00"),
    balanceAfter: brl("15.00"),
    walletVersion: 2,
    createdAt: at,
  };

  test("is structurally immutable", () => {
    const e = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { balanceAfter: Money }).balanceAfter = brl("99.00");
    }).toThrow();
  });

  test("factory rejects unbalanced arithmetic", () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("15.01") })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit })).toThrow(
      InvariantViolationError,
    );
  });

  test("factory rejects non-positive amounts", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: Money.zero("BRL"), balanceAfter: brl("5.00") }),
    ).toThrow(InvariantViolationError);
  });
});

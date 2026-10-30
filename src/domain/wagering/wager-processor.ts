import { Money } from "../shared/money";
import type { Wallet } from "../wallet/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from "./wager-transaction";

export interface ReferenceLookup {
  /** Transaction resolved by (providerId, referenceExternalTransactionId), if it exists. */
  reference?: WagerTransaction;
  /** Whether `reference` was already reversed by a PROCESSED REFUND/ROLLBACK. */
  alreadyReversed: boolean;
}

export type ProcessOutcome =
  | { type: "processed"; entry?: WalletLedgerEntry; reference?: WagerTransaction }
  | { type: "rejected"; code: FailureCode }
  | { type: "pending_reference" };

/**
 * Applies the business rules of section 7 to a PENDING / PENDING_REFERENCE transaction.
 *
 * Pure domain service: no I/O. The caller loads the wallet (locked), the reference and the
 * "already reversed" fact inside one SQL transaction, calls `process`, then persists the
 * mutated wallet, transaction and (optional) ledger entry atomically.
 */
export class WagerProcessor {
  constructor(private readonly retryPolicy: ReferenceRetryPolicy) {}

  process(
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    lookup: ReferenceLookup,
    now: Date,
  ): ProcessOutcome {
    if (!wallet) return this.reject(tx, FailureCode.WalletNotFound, undefined, now);
    if (wallet.playerId !== tx.playerId) {
      return this.reject(tx, FailureCode.WalletPlayerMismatch, wallet.balance, now);
    }
    if (wallet.currency !== tx.money.currency) {
      return this.reject(tx, FailureCode.CurrencyMismatch, wallet.balance, now);
    }

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      const verdict = this.checkReference(tx, lookup);
      if (verdict === "wait") return this.waitForReference(tx, wallet, now);
      if (verdict !== "ok") return this.reject(tx, verdict, wallet.balance, now);
      reference = lookup.reference;
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, wallet.balance, now);
      return { type: "processed", reference };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      const code =
        tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
      return this.reject(tx, code, wallet.balance, now);
    }

    const entry = wallet.move(direction, tx.money, tx.id, now);
    tx.markProcessed(reference?.id, wallet.balance, now);
    return { type: "processed", entry, reference };
  }

  private checkReference(tx: WagerTransaction, lookup: ReferenceLookup): FailureCode | "wait" | "ok" {
    const ref = lookup.reference;
    if (!ref) return "wait";
    if (ref.status === WagerTransactionStatus.Pending || ref.status === WagerTransactionStatus.PendingReference) {
      return "wait";
    }
    if (!tx.canReference(ref)) return FailureCode.ReferenceKindNotAllowed;
    if (
      ref.providerId !== tx.providerId ||
      ref.playerId !== tx.playerId ||
      ref.walletId !== tx.walletId ||
      ref.roundId !== tx.roundId ||
      ref.money.currency !== tx.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (tx.isReversal()) {
      if (!ref.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
      if (lookup.alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    return "ok";
  }

  private waitForReference(tx: WagerTransaction, wallet: Wallet, now: Date): ProcessOutcome {
    // First park does not count as a retry; every re-check while parked does.
    const attempts = tx.status === WagerTransactionStatus.PendingReference ? tx.referenceAttempts + 1 : 0;
    if (this.retryPolicy.isExhausted(attempts)) {
      return this.reject(tx, FailureCode.ReferenceNotFound, wallet.balance, now);
    }
    tx.markPendingReference(this.retryPolicy.nextCheckAt(attempts, now));
    return { type: "pending_reference" };
  }

  private reject(
    tx: WagerTransaction,
    code: FailureCode,
    observedBalance: Money | undefined,
    now: Date,
  ): ProcessOutcome {
    tx.reject(code, observedBalance, now);
    return { type: "rejected", code };
  }
}

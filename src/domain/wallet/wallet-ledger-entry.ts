import { InvariantViolationError } from "../shared/domain-error";
import { newId } from "../shared/id";
import { Money } from "../shared/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version produced by this movement (1 for the opening credit). */
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  id: string;
}

/**
 * Immutable ledger line. No mutable fields and no transition methods: once built it can only be read.
 * The database enforces the same (UPDATE/DELETE are blocked by trigger).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      newId(props.createdAt.getTime()),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      new Date(props.createdAt),
    );
    if (!entry.money.isPositive()) {
      throw new InvariantViolationError("Ledger entry amount must be positive");
    }
    if (entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError("Ledger entry would leave a negative balance");
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvariantViolationError("Ledger entry walletVersion must be a positive integer");
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError("Ledger entry is not balanced: before ± amount !== after");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      new Date(state.createdAt),
    );
  }

  /** Signed effect on the balance: +money for credits, -money for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  /** balanceBefore ± money === balanceAfter (throws on currency mismatch). */
  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }
}

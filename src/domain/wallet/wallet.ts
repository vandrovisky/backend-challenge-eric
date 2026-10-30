import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvariantViolationError,
} from "../shared/domain-error";
import { Money } from "../shared/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Id of the internal OPENING transaction; required when initialBalance > 0. */
  openingTransactionId?: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** CREDIT entry for the opening balance; absent when the wallet opens at zero. */
  openingEntry?: WalletLedgerEntry;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * The balance never changes without producing a ledger entry: `debit`/`credit` are the only
 * mutators and both return the entry that must be persisted in the same SQL transaction.
 * `version` starts at 1 and increments only when the balance changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet. The opening balance is part of creation, so the wallet starts at version 1
   * whatever the initial balance; a positive balance yields the matching opening CREDIT entry.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvariantViolationError("Initial balance must not be negative");
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(at),
      new Date(at),
    );
    if (initialBalance.isZero()) return { wallet };

    if (!props.openingTransactionId) {
      throw new InvariantViolationError("A positive initial balance requires an opening transaction");
    }
    const openingEntry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — trusts stored state, does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError when the debit would make the balance negative. */
  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) throw new InsufficientFundsError();
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  /** Applies a movement in the given direction (used for reversals whose direction is derived). */
  move(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    return direction === LedgerDirection.Debit
      ? this.debit(money, transactionId, at)
      : this.credit(money, transactionId, at);
  }

  private apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);
    // WalletLedgerEntry.create validates positivity, non-negativity and arithmetic before we mutate.
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = new Date(at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

import type { MoneyProps } from "../shared/money";
import type { FailureCode } from "../wagering/failure-code";
import type { WagerTransaction, WagerTransactionKind } from "../wagering/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { IntegrationEvent, type EventContext } from "./integration-event";

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionEventData {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.props(
        tx.id,
        {
          ...transactionData(tx),
          ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
          balance: tx.resultingBalance!.toJSON(),
          processedAt: tx.processedAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.props(
        tx.id,
        { ...transactionData(tx), failureCode: tx.failureCode!, rejectedAt: tx.processedAt!.toISOString() },
        ctx,
      ),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(
        tx.id,
        {
          ...transactionData(tx),
          referenceExternalTransactionId: tx.referenceExternalTransactionId!,
          nextCheckAt: tx.nextReferenceCheckAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }
}

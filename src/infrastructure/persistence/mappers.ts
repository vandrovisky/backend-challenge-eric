import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/shared/money";
import type { FailureCode } from "../../domain/wagering/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry, type LedgerDirection } from "../../domain/wallet/wallet-ledger-entry";
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

/** Record (row) ↔ domain translation. Reads always go through `rehydrate` (no re-validation). */

const money = (amount: string, currency: string) => Money.from({ amount, currency });

export const walletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const transactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: r.processedAt ?? undefined,
      resultingBalance: r.resultingBalance !== null ? money(r.resultingBalance, r.currency) : undefined,
      referenceAttempts: r.referenceAttempts,
      nextReferenceCheckAt: r.nextReferenceCheckAt ?? undefined,
    });
  },
  toRecord(t: WagerTransaction, updatedAt: Date): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      resultingBalance: t.resultingBalance?.amount ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceCheckAt: t.nextReferenceCheckAt ?? null,
      createdAt: t.createdAt,
      updatedAt,
      processedAt: t.processedAt ?? null,
    };
  },
};

export const ledgerMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const inboxMapper = {
  toDomain(r: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: r.messageId,
      consumerName: r.consumerName,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt ?? undefined,
    });
  },
};

export const outboxMapper = {
  fromRow(r: {
    id: string;
    aggregate_id: string;
    event_type: string;
    payload: Record<string, unknown> | string;
    occurred_at: Date | string;
    attempts: number;
    next_attempt_at: Date | string | null;
    published_at: Date | string | null;
  }): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      occurredAt: new Date(r.occurred_at),
      attempts: Number(r.attempts),
      nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
      publishedAt: r.published_at ? new Date(r.published_at) : undefined,
    });
  },
  toRecord(m: OutboxMessage): OutboxMessageRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      payload: m.payload as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? null,
      publishedAt: m.publishedAt ?? null,
      lastError: null,
    };
  },
};

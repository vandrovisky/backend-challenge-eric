import { EntitySchema } from "@mikro-orm/core";

/**
 * Persistence records: flat row shapes mapped by MikroORM via EntitySchema (no decorators).
 * They are NOT the domain model — repositories translate them with `Domain.rehydrate(...)`.
 * Decimal columns are strings end to end; they never pass through `number`.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultingBalance!: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt!: Date | null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  transactionId!: string | null;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  lastError!: string | null;
}

const money = { type: "decimal", precision: 20, scale: 2 } as const;
const tstz = { type: "datetime", columnType: "timestamptz" } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid", fieldName: "player_id" },
    currency: { type: "string", columnType: "char(3)" },
    balance: { ...money },
    version: { type: "integer" },
    createdAt: { ...tstz, fieldName: "created_at" },
    updatedAt: { ...tstz, fieldName: "updated_at" },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id" },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "string", fieldName: "idempotency_key" },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "uuid", fieldName: "player_id" },
    roundId: { type: "string", fieldName: "round_id" },
    gameId: { type: "string", fieldName: "game_id" },
    kind: { type: "string" },
    amount: { ...money },
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    referenceTransactionId: { type: "uuid", fieldName: "reference_transaction_id", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", fieldName: "failure_code", nullable: true },
    resultingBalance: { ...money, fieldName: "resulting_balance", nullable: true },
    referenceAttempts: { type: "integer", fieldName: "reference_attempts" },
    nextReferenceCheckAt: { ...tstz, fieldName: "next_reference_check_at", nullable: true },
    createdAt: { ...tstz, fieldName: "created_at" },
    updatedAt: { ...tstz, fieldName: "updated_at" },
    processedAt: { ...tstz, fieldName: "processed_at", nullable: true },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string" },
    amount: { ...money },
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: { ...money, fieldName: "balance_before" },
    balanceAfter: { ...money, fieldName: "balance_after" },
    walletVersion: { type: "integer", fieldName: "wallet_version" },
    createdAt: { ...tstz, fieldName: "created_at" },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", fieldName: "consumer_name", primary: true },
    messageId: { type: "string", fieldName: "message_id", primary: true },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    transactionId: { type: "uuid", fieldName: "transaction_id", nullable: true },
    receivedAt: { ...tstz, fieldName: "received_at" },
    processedAt: { ...tstz, fieldName: "processed_at", nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid", fieldName: "aggregate_id" },
    eventType: { type: "string", fieldName: "event_type" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { ...tstz, fieldName: "occurred_at" },
    attempts: { type: "integer" },
    nextAttemptAt: { ...tstz, fieldName: "next_attempt_at", nullable: true },
    publishedAt: { ...tstz, fieldName: "published_at", nullable: true },
    lastError: { type: "string", fieldName: "last_error", nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];

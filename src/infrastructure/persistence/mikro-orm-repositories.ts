import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError } from "../../application/errors";
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports/persistence";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/shared/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { inboxMapper, ledgerMapper, outboxMapper, transactionMapper, walletMapper } from "./mappers";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

/*
 * Repositories are thin data mappers over a transaction-scoped EntityManager.
 * Reads bypass the identity map (`disableIdentityMap`) so every read reflects the database, and
 * writes are explicit statements (insert / conditional update) executed in a deterministic order —
 * on the financial path we want to see and control every SQL statement.
 */
const FRESH = { disableIdentityMap: true } as const;

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, FRESH);
    return r ? walletMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE });
    return r ? walletMapper.toDomain(r) : undefined;
  }

  async lockForShare(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_READ });
    return r ? walletMapper.toDomain(r) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletMapper.toRecord(wallet));
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`wallet ${wallet.id} changed since version ${expectedVersion}`);
    }
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  private async one(where: Record<string, unknown>, lock = false): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(
      WagerTransactionRecord,
      where,
      lock ? { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE } : FRESH,
    );
    return r ? transactionMapper.toDomain(r) : undefined;
  }

  findById(id: string) {
    return this.one({ id });
  }

  lockById(id: string) {
    return this.one({ id }, true);
  }

  findByIdempotencyKey(idempotencyKey: string) {
    return this.one({ idempotencyKey });
  }

  findByProviderExternalId(providerId: string, externalTransactionId: string) {
    return this.one({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: transactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: "PROCESSED",
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, transactionMapper.toRecord(tx, tx.processedAt ?? tx.createdAt));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const { id, ...row } = transactionMapper.toRecord(tx, new Date());
    // Only mutable columns are sent; the DB trigger rejects any change to business fields anyway.
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id, status: { $in: ["PENDING", "PENDING_REFERENCE"] } },
      {
        status: row.status,
        referenceTransactionId: row.referenceTransactionId,
        failureCode: row.failureCode,
        resultingBalance: row.resultingBalance,
        referenceAttempts: row.referenceAttempts,
        nextReferenceCheckAt: row.nextReferenceCheckAt,
        processedAt: row.processedAt,
        updatedAt: row.updatedAt,
      },
    );
    if (affected !== 1) throw new ConcurrencyConflictError(`transaction ${id} is no longer open`);
  }

  async wakeDependents(providerId: string, externalTransactionId: string, at: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: "PENDING_REFERENCE",
        nextReferenceCheckAt: { $gt: at },
      },
      { nextReferenceCheckAt: at, updatedAt: at },
    );
  }

  async findDuePendingReferences(now: Date, limit: number) {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: "PENDING_REFERENCE", nextReferenceCheckAt: { $lte: now } },
      { ...FRESH, fields: ["id", "walletId"], orderBy: { nextReferenceCheckAt: "asc" }, limit },
    );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerMapper.toRecord(entry));
  }

  async list(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { ...FRESH, orderBy: { walletVersion: "asc" }, limit: limit + 1 },
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map(ledgerMapper.toDomain),
      nextAfterVersion: rows.length > limit ? page[page.length - 1]!.walletVersion : undefined,
    };
  }

  async replay(walletId: string, currency: string): Promise<{ balance: Money; entries: number }> {
    // Signed sum computed by Postgres in exact numeric, returned as text — never a JS number.
    const [row] = await this.em.execute<{ total: string; n: number }[]>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS total,
              COUNT(*)::int AS n
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    return {
      balance: Money.from({ amount: row!.total, currency }, { allowNegative: true }),
      entries: Number(row!.n),
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const r = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, FRESH);
    return r ? inboxMapper.toDomain(r) : undefined;
  }

  async tryInsert(message: InboxMessage, transactionId?: string): Promise<boolean> {
    // ON CONFLICT DO NOTHING waits for a concurrent inserter of the same key to finish:
    // if it committed we get 0 rows (duplicate), if it rolled back our insert goes through.
    const rows = await this.em.execute<{ inserted: number }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, transaction_id, received_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING 1 AS inserted`,
      [message.consumerName, message.messageId, message.payloadHash, transactionId ?? null, message.receivedAt],
    );
    return rows.length === 1;
  }

  async markProcessed(message: InboxMessage, transactionId: string | undefined): Promise<void> {
    message.markProcessed(new Date());
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt!, transactionId: transactionId ?? null },
    );
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(outboxMapper.toRecord));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // Explicit SQL so the locking clause is visible: SKIP LOCKED is what makes N publishers safe.
    const rows = await this.em.execute<OutboxRow[]>(
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= ?
        ORDER BY occurred_at, id
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(outboxMapper.fromRow);
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      { publishedAt: message.publishedAt!, nextAttemptAt: null, lastError: null },
    );
  }

  async scheduleRetry(message: OutboxMessage, error: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt!, lastError: error.slice(0, 1000) },
    );
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

export function createRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

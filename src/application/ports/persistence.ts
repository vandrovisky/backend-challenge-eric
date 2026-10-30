import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/shared/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: serializes every writer of this wallet until commit. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR SHARE: blocks writers (not readers) until commit — for consistent multi-read checks. */
  lockForShare(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * Conditional write: `UPDATE ... WHERE id = ? AND version = expectedVersion`.
   * Throws ConcurrencyConflictError if no row matched (someone else moved the wallet).
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Row-locks the transaction (used by the reference worker). */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** True when a PROCESSED REFUND/ROLLBACK already points at `transactionId`. */
  hasProcessedReversal(transactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  /** Pulls forward the next check of transactions waiting on (providerId, externalTransactionId). */
  wakeDependents(providerId: string, externalTransactionId: string, at: Date): Promise<number>;
  /**
   * PENDING_REFERENCE transactions whose next check is due, oldest first. Not a claim: the worker
   * re-checks each one under the wallet lock, so two workers picking the same id is harmless.
   */
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextAfterVersion?: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Entries ordered by wallet_version ascending, strictly after `afterVersion`. */
  list(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage>;
  /** Balance rebuilt from the ledger (sum of signed amounts) and the number of entries read. */
  replay(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** INSERT ... ON CONFLICT DO NOTHING. Returns false if the message was already recorded. */
  tryInsert(message: InboxMessage, transactionId?: string): Promise<boolean>;
  markProcessed(message: InboxMessage, transactionId: string | undefined): Promise<void>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /**
   * Due, unpublished messages, row-locked with FOR UPDATE SKIP LOCKED: concurrent publishers each get a
   * disjoint batch, and a crashed publisher's rows unlock on rollback for someone else to take.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  scheduleRetry(message: OutboxMessage, error: string): Promise<void>;
}

/** Repositories bound to ONE open SQL transaction. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Runs `work` inside a single SQL transaction; commits if it resolves, rolls back if it throws.
 * Everything written through the given repositories is atomic.
 */
export interface TransactionRunner {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
  /** Read-only access outside an explicit transaction (queries). */
  read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

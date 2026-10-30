import type { MoneyProps } from "../../domain/shared/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { NotFoundError, PayloadValidationError } from "../errors";
import type { AppLogger, Metrics } from "../ports/observability";
import type { TransactionRunner } from "../ports/persistence";
import { toWalletView, type WalletView } from "../wallets/open-wallet";

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  /** Opaque; pass back as `cursor` to get the next page. null when there is no next page. */
  nextCursor: string | null;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Cursor = base64url(JSON {v: lastWalletVersion}). wallet_version is unique, monotonic and
 * immutable per wallet, so pages are stable even while new entries are appended.
 * Opaque to clients: the encoding may change without breaking them.
 */
export function encodeCursor(afterVersion: number): string {
  return Buffer.from(JSON.stringify({ v: afterVersion })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown };
    if (typeof parsed.v === "number" && Number.isInteger(parsed.v) && parsed.v >= 0) return parsed.v;
  } catch {
    // fallthrough
  }
  throw new PayloadValidationError("Invalid cursor", { fields: { cursor: "malformed" } });
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new PayloadValidationError("Invalid limit", { fields: { limit: "must be an integer" } });
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > MAX_LIMIT) {
    throw new PayloadValidationError("Invalid limit", { fields: { limit: `must be between 1 and ${MAX_LIMIT}` } });
  }
  return n;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(field: string, value: string): string {
  if (!UUID.test(value)) throw new PayloadValidationError(`Invalid ${field}`, { fields: { [field]: "must be a UUID" } });
  return value.toLowerCase();
}

function toLedgerEntryView(e: WalletLedgerEntry): LedgerEntryView {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

export function toTransactionView(t: WagerTransaction): TransactionView {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    ...(t.referenceExternalTransactionId ? { referenceExternalTransactionId: t.referenceExternalTransactionId } : {}),
    ...(t.referenceTransactionId ? { referenceTransactionId: t.referenceTransactionId } : {}),
    ...(t.failureCode ? { failureCode: t.failureCode } : {}),
    ...(t.resultingBalance ? { balance: t.resultingBalance.toJSON() } : {}),
    createdAt: t.createdAt.toISOString(),
    ...(t.processedAt ? { processedAt: t.processedAt.toISOString() } : {}),
  };
}

/** Read side: wallet, ledger, transactions, reconciliation. */
export class WalletQueries {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const id = requireUuid("walletId", walletId);
    const wallet = await this.runner.read((r) => r.wallets.findById(id));
    if (!wallet) throw new NotFoundError("Wallet not found");
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limitRaw: string | undefined): Promise<LedgerPageView> {
    const id = requireUuid("walletId", walletId);
    const afterVersion = decodeCursor(cursor);
    const limit = parseLimit(limitRaw);
    return this.runner.read(async (r) => {
      const wallet = await r.wallets.findById(id);
      if (!wallet) throw new NotFoundError("Wallet not found");
      const page = await r.ledger.list(id, afterVersion, limit);
      return {
        items: page.entries.map(toLedgerEntryView),
        nextCursor: page.nextAfterVersion !== undefined ? encodeCursor(page.nextAfterVersion) : null,
      };
    });
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const id = requireUuid("transactionId", transactionId);
    const tx = await this.runner.read((r) => r.transactions.findById(id));
    if (!tx) throw new NotFoundError("Transaction not found");
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.runner.read((r) => r.transactions.findByProviderExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError("Transaction not found");
    return toTransactionView(tx);
  }

  /**
   * Compares the materialized balance with the balance rebuilt from the ledger. Runs under a
   * FOR SHARE lock on the wallet so no writer can commit between the two reads (no false alarms).
   * Divergences are never corrected here: they are logged, counted and reported.
   */
  async reconcile(walletId: string, ctx: { correlationId: string }): Promise<ReconciliationView> {
    const id = requireUuid("walletId", walletId);
    const result = await this.runner.run(async (r) => {
      const wallet = await r.wallets.lockForShare(id);
      if (!wallet) throw new NotFoundError("Wallet not found");
      const replay = await r.ledger.replay(id, wallet.currency);
      return { wallet, replay };
    });
    const stored = result.wallet.balance;
    const calculated = result.replay.balance;
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    this.metrics.increment("reconciliations_total", { consistent: String(consistent) });
    if (!consistent) {
      this.metrics.increment("reconciliation_divergences_total");
      this.logger.error("wallet reconciliation divergence", {
        correlationId: ctx.correlationId,
        walletId: id,
        checkedEntries: result.replay.entries,
      });
    } else {
      this.logger.info("wallet reconciled", { correlationId: ctx.correlationId, walletId: id });
    }

    return {
      walletId: id,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: result.replay.entries,
    };
  }
}

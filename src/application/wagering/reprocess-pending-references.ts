import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { ConcurrencyConflictError, DuplicateKeyError, TransientInfrastructureError } from "../errors";
import type { AppLogger, Clock, Metrics } from "../ports/observability";
import type { TransactionRunner } from "../ports/persistence";
import type { WagerTransactionApplier } from "./wager-transaction-applier";

export interface ReprocessSummary {
  scanned: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
  errors: number;
}

/**
 * Re-checks PENDING_REFERENCE transactions whose backoff has elapsed. Safe with any number of
 * concurrent workers: each transaction is re-validated under its wallet lock, and one already moved
 * by another worker (status changed, or next check pushed into the future) is skipped.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly applier: WagerTransactionApplier,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async runOnce(batchSize = 50): Promise<ReprocessSummary> {
    const summary: ReprocessSummary = { scanned: 0, processed: 0, rejected: 0, stillPending: 0, skipped: 0, errors: 0 };
    const due = await this.runner.read((r) => r.transactions.findDuePendingReferences(this.clock.now(), batchSize));
    summary.scanned = due.length;

    for (const item of due) {
      try {
        const outcome = await this.reprocess(item.id, item.walletId);
        summary[outcome] += 1;
      } catch (error) {
        summary.errors += 1;
        const transient =
          error instanceof TransientInfrastructureError ||
          error instanceof ConcurrencyConflictError ||
          error instanceof DuplicateKeyError;
        this.metrics.increment("pending_reference_errors_total", { transient: String(transient) });
        this.logger.error("pending reference reprocess failed", {
          transactionId: item.id,
          walletId: item.walletId,
          transient,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (summary.scanned > 0) this.logger.info("pending references reprocessed", { ...summary });
    return summary;
  }

  private async reprocess(
    transactionId: string,
    walletId: string,
  ): Promise<"processed" | "rejected" | "stillPending" | "skipped"> {
    return this.runner.run(async (repos) => {
      const wallet = await repos.wallets.lockById(walletId);
      const tx = await repos.transactions.lockById(transactionId);
      const now = this.clock.now();
      if (
        !tx ||
        tx.status !== WagerTransactionStatus.PendingReference ||
        (tx.nextReferenceCheckAt && tx.nextReferenceCheckAt.getTime() > now.getTime())
      ) {
        return "skipped";
      }
      const outcome = await this.applier.apply(repos, tx, wallet, {
        isNew: false,
        now,
        ctx: { correlationId: tx.id, causationId: tx.id, occurredAt: now },
      });
      this.metrics.increment("wager_retries_total", { reason: "pending_reference" });
      if (outcome.type === "pending_reference") return "stillPending";
      this.metrics.increment("wager_transactions_total", { status: tx.status, kind: tx.kind });
      this.logger.info("pending reference resolved", {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        status: tx.status,
        failureCode: tx.failureCode,
      });
      return outcome.type === "processed" ? "processed" : "rejected";
    });
  }
}

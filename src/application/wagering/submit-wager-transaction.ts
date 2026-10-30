import { InboxMessage } from "../../domain/messaging/inbox-message";
import type { EventContext } from "../../domain/messaging/integration-event";
import { ValidationError } from "../../domain/shared/domain-error";
import { newId } from "../../domain/shared/id";
import type { MoneyProps } from "../../domain/shared/money";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction, WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import {
  ApplicationError,
  ConcurrencyConflictError,
  DuplicateKeyError,
  IdempotencyConflictError,
  PayloadValidationError,
  PermanentProcessingError,
  TransientInfrastructureError,
} from "../errors";
import type { AppLogger, Clock, Metrics } from "../ports/observability";
import type { TransactionalRepositories, TransactionRunner } from "../ports/persistence";
import { validateWagerCommand, type SubmitWagerCommand, type ValidatedWagerCommand } from "./wager-command";
import type { WagerTransactionApplier } from "./wager-transaction-applier";

export interface SubmitContext {
  correlationId: string;
  causationId?: string;
  /** Present when the submission comes from the queue: enables inbox dedup in the same SQL transaction. */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the transaction was decided (stable across replays). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/** Races we resolve by simply running again (the next attempt lands on the replay path). */
const MAX_ATTEMPTS = 4;

/**
 * The single entry point for provider operations — used by BOTH the HTTP controller and the SQS
 * consumer.
 *
 * Concurrency: the wallet row is locked (SELECT ... FOR UPDATE) for the whole SQL transaction, so all
 * writers of one wallet are serialized across every instance, while different wallets proceed in
 * parallel. The idempotency lookup is repeated *after* acquiring the lock, which makes N parallel
 * duplicates collapse into one effect + N-1 replays.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly applier: WagerTransactionApplier,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitWagerResult> {
    const started = performance.now();
    const cmd = validateWagerCommand(command);
    const log = this.logger.child({
      correlationId: ctx.correlationId,
      messageId: ctx.inbox?.messageId,
      providerId: cmd.providerId,
      walletId: cmd.walletId,
      kind: cmd.kind,
    });

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.attempt(cmd, ctx);
        const durationMs = Math.round(performance.now() - started);
        this.metrics.observe("wager_processing_duration_ms", durationMs, { kind: cmd.kind });
        if (result.idempotentReplay) {
          this.metrics.increment("wager_duplicates_total", { source: ctx.inbox ? "sqs" : "http" });
        } else {
          this.metrics.increment("wager_transactions_total", { status: result.status, kind: cmd.kind });
        }
        log.info("wager transaction handled", {
          transactionId: result.transactionId,
          status: result.status,
          failureCode: result.failureCode,
          idempotentReplay: result.idempotentReplay,
          attempt,
          durationMs,
        });
        return result;
      } catch (error) {
        if ((error instanceof DuplicateKeyError || error instanceof ConcurrencyConflictError) && attempt < MAX_ATTEMPTS) {
          this.metrics.increment("wager_lock_conflicts_total", {
            reason: error instanceof DuplicateKeyError ? "duplicate_key_race" : "version_conflict",
          });
          log.debug("write race, retrying", { attempt, reason: error.message });
          continue;
        }
        if (error instanceof TransientInfrastructureError && ["lock_timeout", "deadlock", "serialization"].includes(error.reason)) {
          this.metrics.increment("wager_lock_conflicts_total", { reason: error.reason });
        }
        if (error instanceof TransientInfrastructureError && attempt < MAX_ATTEMPTS) {
          this.metrics.increment("wager_retries_total", { reason: error.reason });
          log.warn("transient failure, retrying", { attempt, err: error.message });
          await Bun.sleep(25 * 2 ** attempt + Math.random() * 25);
          continue;
        }
        if (error instanceof IdempotencyConflictError) {
          this.metrics.increment("wager_idempotency_conflicts_total");
          log.warn("idempotency conflict", { err: error.message });
          throw error;
        }
        if (error instanceof ApplicationError) throw error;
        if (error instanceof DuplicateKeyError || error instanceof ConcurrencyConflictError) {
          throw new TransientInfrastructureError("Contention did not resolve within retry budget", error, "contention");
        }
        // Unknown / programming error: make it auditable as FAILED, then surface as permanent.
        log.error("permanent processing error", { err: error instanceof Error ? error.message : String(error) });
        const failed = await this.recordFailure(cmd, ctx).catch(() => undefined);
        throw new PermanentProcessingError("Transaction could not be processed", failed);
      }
    }
  }

  private async attempt(cmd: ValidatedWagerCommand, ctx: SubmitContext): Promise<SubmitWagerResult> {
    // Fast path outside any lock: retries of already-decided transactions never contend for the wallet.
    if (!ctx.inbox) {
      const known = await this.runner.read((r) => r.transactions.findByIdempotencyKey(cmd.idempotencyKey));
      if (known?.isTerminal()) return this.replay(known, cmd);
    }

    const now = this.clock.now();
    const candidate = this.buildTransaction(cmd, now);

    return this.runner.run(async (repos) => {
      // Lock order is always inbox → wallet, on every path, so duplicates cannot deadlock.
      let inbox: InboxMessage | undefined;
      if (ctx.inbox) {
        inbox = InboxMessage.receive({ ...ctx.inbox, payloadHash: cmd.payloadHash, receivedAt: now });
        const fresh = await repos.inbox.tryInsert(inbox);
        if (!fresh) return this.replayDuplicateMessage(repos, cmd, ctx.inbox);
      }

      const lockStarted = performance.now();
      const wallet = await repos.wallets.lockById(cmd.walletId);
      // Time spent queued behind other writers of this wallet: the "hot wallet" signal.
      this.metrics.observe("wallet_lock_wait_ms", performance.now() - lockStarted);

      // Authoritative idempotency check, now serialized with every other writer of this wallet.
      const existing = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
      if (existing) {
        const result = this.replay(existing, cmd);
        if (inbox) await repos.inbox.markProcessed(inbox, existing.id);
        return result;
      }
      const sameExternal = await repos.transactions.findByProviderExternalId(cmd.providerId, cmd.externalTransactionId);
      // Same key committed between the two reads (possible when there is no wallet row to lock).
      if (sameExternal?.idempotencyKey === cmd.idempotencyKey) return this.replay(sameExternal, cmd);
      if (sameExternal) {
        throw new IdempotencyConflictError(
          "externalTransactionId was already submitted under a different Idempotency-Key",
          { transactionId: sameExternal.id },
        );
      }

      const ectx: EventContext = { correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: now };
      await this.applier.apply(repos, candidate, wallet, { isNew: true, now, ctx: ectx });
      if (inbox) await repos.inbox.markProcessed(inbox, candidate.id);
      return this.toResult(candidate, false);
    });
  }

  private buildTransaction(cmd: ValidatedWagerCommand, now: Date): WagerTransaction {
    try {
      return WagerTransaction.create({ ...cmd, id: newId(now.getTime()), createdAt: now });
    } catch (e) {
      if (e instanceof ValidationError) throw new PayloadValidationError(e.message);
      throw e;
    }
  }

  private async replayDuplicateMessage(
    repos: TransactionalRepositories,
    cmd: ValidatedWagerCommand,
    source: { consumerName: string; messageId: string },
  ): Promise<SubmitWagerResult> {
    const recorded = await repos.inbox.find(source.consumerName, source.messageId);
    if (recorded && recorded.payloadHash !== cmd.payloadHash) {
      throw new IdempotencyConflictError("messageId was already consumed with a different payload");
    }
    const tx = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (!tx) throw new PermanentProcessingError("Inbox record without transaction");
    return this.replay(tx, cmd);
  }

  private replay(existing: WagerTransaction, cmd: ValidatedWagerCommand): SubmitWagerResult {
    if (!existing.matchesPayload(cmd.payloadHash)) {
      throw new IdempotencyConflictError("Idempotency-Key was already used with a different payload", {
        transactionId: existing.id,
      });
    }
    return this.toResult(existing, true);
  }

  private toResult(tx: WagerTransaction, idempotentReplay: boolean): SubmitWagerResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      ...(tx.resultingBalance ? { balance: tx.resultingBalance.toJSON() } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay,
    };
  }

  /** Persists the submission as FAILED (terminal, auditable) in its own SQL transaction. */
  private async recordFailure(cmd: ValidatedWagerCommand, ctx: SubmitContext): Promise<string | undefined> {
    return this.runner.run(async (repos) => {
      const existing = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
      if (existing) return existing.id;
      const now = this.clock.now();
      const tx = this.buildTransaction(cmd, now);
      tx.fail(FailureCode.PermanentProcessingError, now);
      await repos.transactions.insert(tx);
      if (ctx.inbox) {
        const inbox = InboxMessage.receive({ ...ctx.inbox, payloadHash: cmd.payloadHash, receivedAt: now });
        if (await repos.inbox.tryInsert(inbox)) await repos.inbox.markProcessed(inbox, tx.id);
      }
      this.metrics.increment("wager_transactions_total", { status: WagerTransactionStatus.Failed, kind: cmd.kind });
      return tx.id;
    });
  }
}


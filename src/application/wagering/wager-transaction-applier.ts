import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/events";
import type { EventContext, IntegrationEvent } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { ProcessOutcome, ReferenceLookup, WagerProcessor } from "../../domain/wagering/wager-processor";
import { WagerTransactionStatus, type WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { TransactionalRepositories } from "../ports/persistence";

/**
 * Applies a transaction to its (already locked) wallet and persists every consequence in the
 * caller's SQL transaction: transaction row, wallet balance, ledger entry, outbox events.
 * Nothing here commits — the TransactionRunner does, all or nothing.
 */
export class WagerTransactionApplier {
  constructor(private readonly processor: WagerProcessor) {}

  async apply(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    opts: { isNew: boolean; now: Date; ctx: EventContext },
  ): Promise<ProcessOutcome> {
    const { isNew, now, ctx } = opts;
    const previousStatus = tx.status;
    const versionBefore = wallet?.version;

    const lookup = await this.lookupReference(repos, tx);
    const outcome = this.processor.process(tx, wallet, lookup, now);

    // 1. transaction row (must exist before the ledger entry that references it)
    if (isNew) await repos.transactions.insert(tx);
    else await repos.transactions.update(tx);

    // 2. balance + ledger, only when money moved
    const events: IntegrationEvent<unknown>[] = [];
    if (outcome.type === "processed") {
      if (outcome.entry && wallet && versionBefore !== undefined) {
        await repos.wallets.update(wallet, versionBefore);
        await repos.ledger.append(outcome.entry);
        events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx));
      }
      events.unshift(WagerTransactionProcessed.from(tx, ctx));
    } else if (outcome.type === "rejected") {
      events.push(WagerTransactionRejected.from(tx, ctx));
    } else if (previousStatus !== WagerTransactionStatus.PendingReference) {
      // announce the park once, not on every re-check
      events.push(WagerTransactionPendingReference.from(tx, ctx));
    }

    // 3. integration events, same SQL transaction (transactional outbox)
    if (events.length > 0) await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));

    // 4. anything parked waiting for THIS transaction can be re-checked right away
    if (tx.isTerminal()) {
      await repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
    }
    return outcome;
  }

  private async lookupReference(repos: TransactionalRepositories, tx: WagerTransaction): Promise<ReferenceLookup> {
    if (!tx.referenceExternalTransactionId) return { alreadyReversed: false };
    const reference = await repos.transactions.findByProviderExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId,
    );
    const alreadyReversed =
      reference !== undefined && tx.isReversal() && (await repos.transactions.hasProcessedReversal(reference.id));
    return { reference, alreadyReversed };
  }
}

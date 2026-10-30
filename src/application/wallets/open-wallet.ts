import { WalletBalanceChanged } from "../../domain/messaging/events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { DomainError } from "../../domain/shared/domain-error";
import { newId } from "../../domain/shared/id";
import { Money, type MoneyProps } from "../../domain/shared/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { DuplicateKeyError, PayloadValidationError, ResourceConflictError } from "../errors";
import type { AppLogger, Clock, Metrics } from "../ports/observability";
import type { TransactionRunner } from "../ports/persistence";

export interface OpenWalletCommand {
  playerId: unknown;
  initialBalance: unknown;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates a wallet. A positive initial balance produces an internal OPENING transaction and its
 * CREDIT ledger entry in the SAME SQL transaction as the wallet row.
 */
export class OpenWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: OpenWalletCommand, ctx: { correlationId: string }): Promise<WalletView> {
    const fields: Record<string, string> = {};
    if (typeof command.playerId !== "string" || !UUID.test(command.playerId)) fields.playerId = "must be a UUID";
    let initialBalance: Money | undefined;
    try {
      initialBalance = Money.from(command.initialBalance as MoneyProps);
    } catch (e) {
      fields.initialBalance = e instanceof DomainError ? e.message : "invalid money";
    }
    if (Object.keys(fields).length > 0 || !initialBalance) {
      throw new PayloadValidationError("Invalid wallet payload", { fields });
    }
    const playerId = (command.playerId as string).toLowerCase();
    const balance = initialBalance;

    try {
      const wallet = await this.runner.run(async (repos) => {
        const now = this.clock.now();
        const walletId = newId(now.getTime());
        const opening = balance.isPositive()
          ? WagerTransaction.opening({ id: newId(now.getTime()), walletId, playerId, money: balance, at: now })
          : undefined;

        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance: balance,
          openingTransactionId: opening?.id,
          at: now,
        });

        if (opening) {
          opening.markProcessed(undefined, wallet.balance, now);
          await repos.transactions.insert(opening);
        }
        await repos.wallets.insert(wallet);
        if (openingEntry) {
          await repos.ledger.append(openingEntry);
          const event = WalletBalanceChanged.from(wallet, openingEntry, {
            correlationId: ctx.correlationId,
            occurredAt: now,
          });
          await repos.outbox.enqueue([OutboxMessage.enqueue(event)]);
        }
        return wallet;
      });

      this.metrics.increment("wallets_opened_total");
      this.logger.info("wallet opened", { correlationId: ctx.correlationId, walletId: wallet.id });
      return toWalletView(wallet);
    } catch (e) {
      if (e instanceof DuplicateKeyError && e.constraint === "uq_wallets_player_currency") {
        throw new ResourceConflictError("WALLET_ALREADY_EXISTS", "A wallet for this player and currency already exists");
      }
      throw e;
    }
  }
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}
